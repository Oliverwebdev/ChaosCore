/* Programm-Starter: die kleine .exe, die der Kunde per Icon startet.
 * Sie startet den eigentlichen Server (Node.js, mitgeliefert) ohne Konsolenfenster.
 *   <Ordner>\<Name>.exe          dieser Starter (hat das Icon)
 *   <Ordner>\runtime\ucc-node.exe  mitgelieferte Node.js-Laufzeit
 *   <Ordner>\app\src\server.js     das Programm
 * Daten (Einstellungen, Twitch-Login, Protokoll) liegen in %APPDATA%\<Name>;
 * mit einer Datei "portable.flag" neben der .exe liegen sie stattdessen im Ordner "data" daneben.
 * Gebaut mit mingw-w64: x86_64-w64-mingw32-gcc -municode -mwindows -static ... */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shlobj.h>
#include <wchar.h>

#ifndef APP_NAME
#define APP_NAME L"ChaosCore"
#endif

static void fail(const wchar_t *msg) {
  MessageBoxW(NULL, msg, APP_NAME, MB_OK | MB_ICONERROR);
}

static int exists(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR args, int show) {
  (void)inst; (void)prev; (void)show;
  wchar_t exe[MAX_PATH * 2], dir[MAX_PATH * 2], node[MAX_PATH * 2], script[MAX_PATH * 2], appdir[MAX_PATH * 2];
  wchar_t data[MAX_PATH * 2], flag[MAX_PATH * 2], envdata[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(NULL, exe, (DWORD)(sizeof(exe) / sizeof(exe[0])));
  if (n == 0 || n >= sizeof(exe) / sizeof(exe[0])) { fail(L"Der Programmpfad ist zu lang."); return 1; }
  wcscpy(dir, exe);
  wchar_t *slash = wcsrchr(dir, L'\\');
  if (!slash) { fail(L"Der Programmpfad ist ungültig."); return 1; }
  *slash = 0;

  swprintf(node, sizeof(node) / sizeof(node[0]), L"%ls\\runtime\\ucc-node.exe", dir);
  swprintf(script, sizeof(script) / sizeof(script[0]), L"%ls\\app\\src\\server.js", dir);
  swprintf(appdir, sizeof(appdir) / sizeof(appdir[0]), L"%ls\\app", dir);
  if (!exists(node) || !exists(script)) {
    fail(L"Programmdateien fehlen. Bitte das Programm neu installieren.");
    return 1;
  }

  /* Datenordner: schon gesetzt > portable > %APPDATA%\<Name> */
  if (GetEnvironmentVariableW(L"UCC_DATA_DIR", envdata, (DWORD)(sizeof(envdata) / sizeof(envdata[0]))) == 0) {
    swprintf(flag, sizeof(flag) / sizeof(flag[0]), L"%ls\\portable.flag", dir);
    if (exists(flag)) {
      swprintf(data, sizeof(data) / sizeof(data[0]), L"%ls\\data", dir);
    } else {
      wchar_t roaming[MAX_PATH];
      if (FAILED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, roaming))) { fail(L"Der Ordner für Einstellungen (AppData) wurde nicht gefunden."); return 1; }
      swprintf(data, sizeof(data) / sizeof(data[0]), L"%ls\\%ls", roaming, APP_NAME);
    }
    SetEnvironmentVariableW(L"UCC_DATA_DIR", data);
  }
  SetEnvironmentVariableW(L"UCC_PACKAGED", L"1");
  SetEnvironmentVariableW(L"UCC_EXE", exe);

  wchar_t cmd[8192];
  swprintf(cmd, sizeof(cmd) / sizeof(cmd[0]), L"\"%ls\" --disable-warning=ExperimentalWarning \"%ls\" %ls", node, script, args ? args : L"");

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  ZeroMemory(&pi, sizeof(pi));
  si.cb = sizeof(si);
  if (!CreateProcessW(node, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, NULL, appdir, &si, &pi)) {
    fail(L"Das Programm konnte nicht gestartet werden.");
    return 1;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return 0;
}
