// WHAM's out-of-process bridge to Windhawk's C ABI. No Windhawk code is bundled.
#include <windows.h>
#include <sddl.h>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <iterator>
#include <string>

int wmain(int argc, wchar_t** argv) {
  // Keep the CLI/compiler and its children in an owned job. Cancellation first
  // uses the CLI's Ctrl+C handler so Windhawk can discard pending artifacts.
  if (argc == 3 && std::wstring(argv[1]) == L"cancel") {
    HANDLE event = nullptr;
    for (int attempt = 0; attempt < 100 && !event; ++attempt) {
      event = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
      if (!event) Sleep(20);
    }
    if (!event) return 0; // The operation may already have finished.
    const bool signaled = SetEvent(event);
    CloseHandle(event);
    return signaled ? 0 : 2;
  }
  const std::wstring mode = argc > 1 ? argv[1] : L"";
  if (argc == 3 && mode == L"control") {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)(A;;GA;;;BA)(A;;GA;;;SY)", SDDL_REVISION_1, &descriptor, nullptr)) return 2;
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    HANDLE event = CreateEventW(&security, TRUE, FALSE, argv[2]);
    LocalFree(descriptor);
    if (!event) return 2;
    std::cout << "ready\n" << std::flush;
    // The caller holds stdin open for exactly the operation's lifetime. EOF
    // cancels a worker even if its elevation wrapper exited unexpectedly.
    while (std::cin.get() != EOF) {}
    SetEvent(event); CloseHandle(event); return 0;
  }
  if ((argc >= 4 && mode == L"run") || (argc >= 5 && mode == L"worker")) {
    auto quoteArgument = [](const std::wstring& argument) {
      // gsudo recognizes its own subcommands before shell dispatch. Leave simple
      // flags/tokens unquoted, as CreateProcess/Node normally do.
      if (!argument.empty() && argument.find_first_of(L" \t\r\n\"&|<>^()%!") == std::wstring::npos) return argument;
      std::wstring quoted = L"\"";
      size_t slashes = 0;
      for (wchar_t character : argument) {
        if (character == L'\\') { ++slashes; continue; }
        quoted.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        quoted += character;
        slashes = 0;
      }
      quoted.append(slashes * 2, L'\\');
      return quoted + L"\"";
    };
    const int executableIndex = mode == L"worker" ? 4 : 3;
    std::wstring executable = argv[executableIndex], commandLine;
    for (int index = executableIndex; index < argc; ++index) {
      if (!commandLine.empty()) commandLine += L' ';
      commandLine += quoteArgument(argv[index]);
    }
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    // Only the creator, administrators, and SYSTEM can use this event. It is
    // created at medium integrity before UAC, never by the elevated worker.
    if (mode != L"worker" && !ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)(A;;GA;;;BA)(A;;GA;;;SY)", SDDL_REVISION_1, &descriptor, nullptr)) return 2;
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    HANDLE cancelEvent = mode == L"worker" ? OpenEventW(SYNCHRONIZE, FALSE, argv[2]) : CreateEventW(&security, TRUE, FALSE, argv[2]);
    if (descriptor) LocalFree(descriptor);
    HANDLE parent = mode == L"worker" ? OpenProcess(SYNCHRONIZE, FALSE, std::stoul(argv[3])) : nullptr;
    if (!cancelEvent || mode == L"worker" && (!parent || WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) || cancelEvent && WaitForSingleObject(cancelEvent, 0) == WAIT_OBJECT_0) {
      if (cancelEvent) CloseHandle(cancelEvent);
      if (parent) CloseHandle(parent);
      return ERROR_CANCELLED;
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!cancelEvent || !job) {
      std::cerr << "Cannot create the process cancellation job.";
      if (cancelEvent) CloseHandle(cancelEvent);
      if (job) CloseHandle(job);
      if (parent) CloseHandle(parent);
      return 2;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    for (HANDLE handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError})
      SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    PROCESS_INFORMATION process{};
    const bool created = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
      CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                     CREATE_SUSPENDED | CREATE_NEW_CONSOLE, nullptr, nullptr, &startup, &process);
    if (!created || !AssignProcessToJobObject(job, process.hProcess)) {
      std::cerr << "Cannot start the managed process (Windows error " << GetLastError() << ").";
      if (process.hProcess) { TerminateProcess(process.hProcess, 2); CloseHandle(process.hProcess); }
      if (process.hThread) CloseHandle(process.hThread);
      CloseHandle(job); CloseHandle(cancelEvent);
      if (parent) CloseHandle(parent);
      return 2;
    }
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    HANDLE waiting[] = {process.hProcess, cancelEvent, parent};
    const DWORD completed = WaitForMultipleObjects(parent ? 3 : 2, waiting, FALSE, INFINITE);
    if (completed == WAIT_OBJECT_0 + 1 || parent && completed == WAIT_OBJECT_0 + 2) {
      FreeConsole();
      bool signaled = false;
      if (AttachConsole(process.dwProcessId)) {
        SetConsoleCtrlHandler(nullptr, TRUE);
        signaled = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
      }
      if (!signaled || WaitForSingleObject(process.hProcess, 10000) == WAIT_TIMEOUT) {
        TerminateJobObject(job, ERROR_CANCELLED);
        WaitForSingleObject(process.hProcess, INFINITE);
      }
    }
    DWORD exitCode = 2;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess);
    CloseHandle(job); CloseHandle(cancelEvent);
    if (parent) CloseHandle(parent);
    return static_cast<int>(exitCode);
  }
  if (argc != 3 || std::wstring(argv[2]) != L"stateless") { std::cerr << "Expected core DLL path and stateless mode."; return 2; }
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  const auto library = LoadLibraryExW(argv[1], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!library) { std::cerr << "Cannot load Windhawk core (Windows error " << GetLastError() << ")."; return 3; }
  const auto abi = reinterpret_cast<int (*)()>(GetProcAddress(library, "WhCoreGetAbiVersion"));
  const auto freeString = reinterpret_cast<void (*)(char*)>(GetProcAddress(library, "WhCoreFree"));
  if (!abi || abi() != 2 || !freeString) { std::cerr << "Unsupported Windhawk core ABI. Update Windhawk."; return 4; }
  const std::string input(std::istreambuf_iterator<char>(std::cin), {});
  const auto invoke = reinterpret_cast<char* (*)(const char*)>(GetProcAddress(library, "WhCoreInvokeStateless"));
  if (!invoke) { std::cerr << "Windhawk's stateless parser is unavailable."; return 4; }
  char* response = invoke(input.c_str());
  if (!response) { std::cerr << "Windhawk core returned no response."; return 5; }
  std::cout << response;
  freeString(response);
  FreeLibrary(library);
  return 0;
}
