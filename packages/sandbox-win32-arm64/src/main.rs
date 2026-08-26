use std::env;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::process::ExitCode;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_QUERY,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn quote_argument(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|item| item.is_whitespace() || item == '"')
    {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for item in value.chars() {
        if item == '\\' {
            slashes += 1;
            continue;
        }
        if item == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
            result.push('"');
        } else {
            result.push_str(&"\\".repeat(slashes));
            result.push(item);
        }
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("run") {
        eprintln!("usage: karin-sandbox run --policy <base64url> -- <command> [args...]");
        return ExitCode::from(2);
    }
    let separator = match args.iter().position(|arg| arg == "--") {
        Some(value) => value,
        None => return ExitCode::from(2),
    };
    if args.get(1).map(String::as_str) != Some("--policy")
        || args.get(2).map(String::is_empty) != Some(false)
    {
        eprintln!("sandbox policy is required");
        return ExitCode::from(2);
    }
    let command = match args.get(separator + 1) {
        Some(value) => value,
        None => return ExitCode::from(2),
    };
    let command_path = wide(command);
    let command_line_value = std::iter::once(command)
        .chain(args[separator + 2..].iter())
        .map(|value| quote_argument(value))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command_line = wide(&command_line_value);

    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("failed to create Job Object");
            return ExitCode::from(1);
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            CloseHandle(job);
            eprintln!("failed to configure Job Object");
            return ExitCode::from(1);
        }

        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        let mut source_token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY,
            &mut source_token,
        ) == 0
        {
            CloseHandle(job);
            eprintln!("failed to open process token");
            return ExitCode::from(1);
        }
        let mut restricted_token: HANDLE = std::ptr::null_mut();
        let restricted = CreateRestrictedToken(
            source_token,
            DISABLE_MAX_PRIVILEGE,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            &mut restricted_token,
        ) != 0;
        CloseHandle(source_token);
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        let mut created = restricted
            && CreateProcessAsUserW(
                restricted_token,
                command_path.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut process,
            ) != 0;
        if restricted {
            CloseHandle(restricted_token);
        }
        if !created {
            command_line = wide(&command_line_value);
            process = std::mem::zeroed();
            created = CreateProcessW(
                command_path.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut process,
            ) != 0;
        }
        if !created {
            CloseHandle(job);
            eprintln!("failed to start sandbox child");
            return ExitCode::from(1);
        }
        if AssignProcessToJobObject(job, process.hProcess) == 0 {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            eprintln!("failed to assign sandbox child to Job Object");
            return ExitCode::from(1);
        }
        if ResumeThread(process.hThread) == u32::MAX {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            eprintln!("failed to resume sandbox child");
            return ExitCode::from(1);
        }
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        let mut code = 1u32;
        let read_exit = GetExitCodeProcess(process.hProcess, &mut code) != 0;
        CloseHandle(process.hProcess);
        CloseHandle(job);
        ExitCode::from(if read_exit { code as u8 } else { 1 })
    }
}
