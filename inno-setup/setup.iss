; ==============================================================================
;  CS2-Bot-Improver — Inno Setup script
;
;  Builds CS2-Bot-Improver-Setup.exe: the Panel application plus every file the
;  plugin needs, installed straight into Counter-Strike 2's `game\csgo` folder.
;
;  Documentation: README.md (English) and README.zh-CN.md (简体中文) in this
;  folder — read those before changing anything here.
;
;  Requires Inno Setup 6.3 or newer (ArchitecturesAllowed=x64compatible).
; ==============================================================================


; ------------------------------------------------------------------------------
;  Paths
; ------------------------------------------------------------------------------
; SourcePath is the folder holding this script (…\inno-setup\) and always ends
; with a separator, so it is stripped before stepping up to the repository root.
; Deriving it this way keeps the script free of any absolute path — it compiles
; from any checkout location.
#define RepoRoot ExtractFileDir(RemoveBackslashUnlessRoot(SourcePath))
#define OutputPath AddBackslash(SourcePath) + "output"


; ------------------------------------------------------------------------------
;  Version — read from Panel/package.json at compile time, never hardcoded.
; ------------------------------------------------------------------------------
; ISPP has no JSON parser, but it can read a file one line at a time
; (FileOpen/FileRead), which is all a single-key lookup needs. Panel/package.json
; is the one place the project version is declared, so the installer, the title
; bar and the update checker can never drift apart.
#define Q """"

#define PanelPkgPath RepoRoot + "\Panel\package.json"

; Everything after the first occurrence of Needle, or "" when it is absent.
#define StrFieldAfter(str Haystack, str Needle) \
  Local[0] = Pos(Needle, Haystack), \
  Local[0] ? Copy(Haystack, Local[0] + Len(Needle)) : ""

; The value of a "key": "value" pair in a JSON document.
#define JsonString(str Json, str Key) \
  Local[0] = StrFieldAfter(Json, Q + Key + Q), \
  Local[0] ? ( \
    Local[0] = StrFieldAfter(Local[0], ":"), \
    Local[0] = StrFieldAfter(Local[0], Q), \
    Local[1] = Pos(Q, Local[0]), \
    Local[1] ? Copy(Local[0], 1, Local[1] - 1) : "" \
  ) : ""

#define PkgHandle ""
#define PkgLine ""
#define PanelVersion ""
#if !FileExists(PanelPkgPath)
  ; #error takes literal text only, so the resolved path is reported separately.
  #expr Warning("Panel\package.json was not found at " + PanelPkgPath)
  #error Panel\package.json is missing. Keep the inno-setup and Panel folders side by side in the same repository.
#endif
#expr PkgHandle = FileOpen(PanelPkgPath)
#sub ReadPkgLine
  #expr PkgLine = FileRead(PkgHandle)
  #if (PanelVersion == "") && (Len(PkgLine) > 0)
    #expr PanelVersion = JsonString(PkgLine, "version")
  #endif
#endsub
#define PkgLineNo 0
#for {PkgLineNo = 0; PkgLineNo < 200; PkgLineNo = PkgLineNo + 1} ReadPkgLine
#expr FileClose(PkgHandle)

#if PanelVersion == ""
  #error Could not read "version" from Panel\package.json. Keep the inno-setup and Panel folders side by side in the same repository.
#endif


; ------------------------------------------------------------------------------
;  Application metadata
; ------------------------------------------------------------------------------
#define MyAppName "CS2-Bot-Improver"
#define MyAppVersion PanelVersion
#define MyAppPublisher "CS2-Bot-Improver contributors"
#define MyAppURL "https://github.com/ed0ard/CS2-Bot-Improver"

; Name the Panel lands under inside game\csgo. Deliberately NOT version-stamped:
; a fixed name means an upgrade overwrites the previous build instead of leaving
; "Panel v1.4.4.exe", "Panel v1.4.5.exe", … behind in the game folder.
#define PanelExeName "CS2-Bot-Improver-Panel.exe"


; ------------------------------------------------------------------------------
;  Payload — the compiled game\csgo tree, which is NOT this repository
; ------------------------------------------------------------------------------
; This repository is source-only by design: .gitignore excludes **/bin/ and
; **/obj/, and the loaders CS2 needs were never committed at all. So a checkout
; contains 97 .cs files and no binaries, while the thing that actually runs is
; ~510 DLLs plus the Metamod stubs and a packed botprofile.vpk.
;
; Building straight from the checkout therefore produces an installer that copies
; source files into game\csgo and no loadable code — CS2 would start with the
; plugin entirely absent. The payload must come from a *distribution* tree
; instead: the contents of the official CS2BotImprover.zip (addons\, backup\,
; cfg\, overrides\, gameinfo.gi, and the Panel executable).
;
; Put that tree in inno-setup\payload\, or point ISCC at it:
;   ISCC /DPayloadRoot="D:\build\CS2BotImprover" setup.iss
#define PayloadDir AddBackslash(SourcePath) + "payload"
#ifndef PayloadRoot
  #if FileExists(PayloadDir + "\gameinfo.gi")
    #define PayloadRoot PayloadDir
  #else
    #define PayloadRoot RepoRoot
  #endif
#endif

; Warns and counts when a required file is absent from the payload. Declared
; before its uses so the counter is updated as each check runs.
#define PayloadMissing 0
#define NeedPayload(str RelPath) \
  Local[0] = PayloadRoot + "\" + RelPath, \
  FileExists(Local[0]) ? 0 : ( \
    Warning("  missing from payload: " + Local[0]), \
    PayloadMissing = PayloadMissing + 1, \
    0 \
  )

; One line per file that CS2 cannot start the plugin without. Every entry here is
; something whose absence is a total, silent failure at run time rather than a
; degraded feature, which is why they are fatal instead of a warning.
#expr NeedPayload("addons\metamod.vdf")
#expr NeedPayload("addons\metamod_x64.vdf")
#expr NeedPayload("addons\metamod\counterstrikesharp.vdf")
#expr NeedPayload("addons\metamod\metaplugins.ini")
#expr NeedPayload("addons\metamod\bin\win64\server.dll")
#expr NeedPayload("addons\metamod\bin\win64\metamod.2.cs2.dll")
#expr NeedPayload("addons\counterstrikesharp\bin\win64\counterstrikesharp.dll")
#expr NeedPayload("addons\counterstrikesharp\dotnet\dotnet.exe")
#expr NeedPayload("addons\counterstrikesharp\configs\core.json")
#expr NeedPayload("addons\counterstrikesharp\gamedata\gamedata.json")
#expr NeedPayload("addons\counterstrikesharp\plugins\BotAI\BotAI.dll")
#expr NeedPayload("addons\BotController\bin\win64\BotController.dll")
#expr NeedPayload("addons\BotHider\bin\win64\BotHider.dll")
#expr NeedPayload("addons\BotVision\bin\win64\BotVision.dll")
#expr NeedPayload("addons\RayTrace\bin\win64\RayTrace.dll")
#expr NeedPayload("gameinfo.gi")
#expr NeedPayload("backup\Online\gameinfo.gi")
#expr NeedPayload("backup\WithBots\gameinfo.gi")
#expr NeedPayload("overrides\botprofile.vpk")
#expr NeedPayload("overrides\Medium\botprofile.vpk")
#expr NeedPayload("cfg\my_bot_normal_config.cfg")

#if PayloadMissing > 0
  #expr Warning("Payload root used: " + PayloadRoot)
  #expr Warning("A source checkout is not a payload — the repository deliberately excludes every compiled binary.")
  #error The payload is incomplete. See the "Payload" comment in setup.iss and the "Payload" section of README.md: build the installer from a distribution tree (inno-setup\payload\, or /DPayloadRoot="..." ).
#endif


; ------------------------------------------------------------------------------
;  Panel executable
; ------------------------------------------------------------------------------
; Not in the repository (its Tauri backend, Panel/src-tauri, is not published),
; so point ISCC at one when building a release:
;   ISCC /DPanelExe="C:\path\to\Panel.exe" setup.iss
; Note this is NOT Panel\dist — that is Vite's web-asset output, not an executable.
#ifndef PanelExe
  #if FileExists(PayloadRoot + "\Panel.exe")
    #define PanelExe PayloadRoot + "\Panel.exe"
  #elif FileExists(PayloadRoot + "\Panel v" + MyAppVersion + ".exe")
    #define PanelExe PayloadRoot + "\Panel v" + MyAppVersion + ".exe"
  #elif FileExists(RepoRoot + "\Panel.exe")
    #define PanelExe RepoRoot + "\Panel.exe"
  #else
    #define PanelExe PayloadRoot + "\Panel.exe"
  #endif
#endif

#if !FileExists(PanelExe)
  #expr Warning("Panel executable not found at " + PanelExe + " — the installer will build without it. Put the packaged Panel at Panel.exe in the payload, or pass /DPanelExe=""<path>"" to ISCC.")
#endif

; The Panel and the rest of the payload have to come from the same release: a
; mismatched pair ships an installer whose version label lies about the Panel
; inside it. Only checked when the executable actually carries version info.
#if FileExists(PanelExe)
  #define PanelExeVersion GetStringFileInfo(PanelExe, PRODUCT_VERSION)
  #if PanelExeVersion != ""
    #if PanelExeVersion != MyAppVersion
      #expr Warning("Panel executable is version " + PanelExeVersion + " but this installer is built as " + MyAppVersion + ". Panel and payload should come from the same release; the installer's version follows Panel\package.json.")
    #endif
  #endif
#endif


; ------------------------------------------------------------------------------
;  Setup
; ------------------------------------------------------------------------------
[Setup]
; AppId identifies this application across upgrades. Never reuse it elsewhere.
AppId={{6924E294-BF23-4595-978E-4121A278CEB4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases/latest
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
; The destination is Counter-Strike 2's own game\csgo folder, located at run time
; by the Pascal Script in [Code] below.
DefaultDirName={code:GetDefaultCsgoDir}
DisableProgramGroupPage=yes
LicenseFile={#RepoRoot}\LICENSE
OutputDir={#OutputPath}
OutputBaseFilename=CS2-Bot-Improver-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern windows11
ArchitecturesAllowed=x64compatible
; The payload goes into a Steam library, which normally needs administrator rights.
PrivilegesRequired=admin
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\{#PanelExeName}


; ------------------------------------------------------------------------------
;  Languages
; ------------------------------------------------------------------------------
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"


; ------------------------------------------------------------------------------
;  Texts not covered by Inno's own translations
; ------------------------------------------------------------------------------
[CustomMessages]
; Shown instead of the standard destination-page blurb when CS2 could not be
; located, so the user knows which folder is expected.
selectdir_notfound=The Counter-Strike 2 folder could not be located automatically.%n%nClick Browse… and select the game\csgo folder inside your CS2 installation (usually inside a Steam library, for example C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo).

cs2running=Counter-Strike 2 appears to be running.%n%nIts files may be locked, which can make the installation fail. Close the game first if possible.%n%nContinue anyway?

chinesesimplified.selectdir_notfound=未能自动定位 Counter-Strike 2 的安装目录。%n%n请点击"浏览…"，选择 CS2 安装目录下的 game\csgo 文件夹（通常在 Steam 库中，例如 C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo）。

chinesesimplified.cs2running=检测到 Counter-Strike 2 正在运行。%n%n游戏文件可能被占用，从而导致安装失败。如有可能，请先关闭游戏。%n%n仍要继续吗？

russian.selectdir_notfound=Не удалось автоматически найти папку Counter-Strike 2.%n%nНажмите «Обзор…» и выберите папку game\csgo внутри установленной игры (обычно в библиотеке Steam, например C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo).

russian.cs2running=Похоже, Counter-Strike 2 запущена.%n%nЕё файлы могут быть заблокированы, из-за чего установка может завершиться ошибкой. По возможности закройте игру.%n%nВсё равно продолжить?

german.selectdir_notfound=Der Counter-Strike-2-Ordner konnte nicht automatisch gefunden werden.%n%nKlicken Sie auf Durchsuchen… und wählen Sie den Ordner game\csgo Ihrer CS2-Installation (üblicherweise in einer Steam-Bibliothek, zum Beispiel C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo).

german.cs2running=Counter-Strike 2 scheint zu laufen.%n%nDie Dateien sind möglicherweise gesperrt, wodurch die Installation fehlschlagen kann. Beenden Sie das Spiel nach Möglichkeit zuerst.%n%nTrotzdem fortfahren?

japanese.selectdir_notfound=Counter-Strike 2 のフォルダーを自動的に特定できませんでした。%n%n「参照…」をクリックし、CS2 インストール先の game\csgo フォルダーを選択してください（通常は Steam ライブラリ内、例: C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo）。

japanese.cs2running=Counter-Strike 2 が実行中のようです。%n%nファイルがロックされ、インストールに失敗する可能性があります。可能であれば先にゲームを終了してください。%n%nこのまま続行しますか？

korean.selectdir_notfound=Counter-Strike 2 폴더를 자동으로 찾지 못했습니다.%n%n"찾아보기…"를 클릭하여 CS2 설치 폴더 안의 game\csgo 폴더를 선택하세요(보통 Steam 라이브러리 안에 있습니다. 예: C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo).

korean.cs2running=Counter-Strike 2가 실행 중인 것 같습니다.%n%n게임 파일이 잠겨 있어 설치가 실패할 수 있습니다. 가능하면 게임을 먼저 종료하세요.%n%n그래도 계속하시겠습니까?


; ------------------------------------------------------------------------------
;  Optional items
; ------------------------------------------------------------------------------
[Tasks]
; The only optional item. The repository's extra material (overrides\archived\,
; *_rules_unchanged.cfg) is deliberately NOT offered: neither is part of the
; distribution — the archived bot profiles are uncompiled .db sources, and the
; rules-unchanged variant ships as its own release zip under the same filenames,
; so installing both sets side by side could not work.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked


; ------------------------------------------------------------------------------
;  Payload
; ------------------------------------------------------------------------------
; Everything here except the documentation comes from {#PayloadRoot}, the
; distribution tree described above — never from the source checkout.
[Files]
; --- The plugin itself ---
Source: "{#PayloadRoot}\addons\*"; DestDir: "{app}\addons"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\cfg\*"; DestDir: "{app}\cfg"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\overrides\*"; DestDir: "{app}\overrides"; Flags: ignoreversion recursesubdirs createallsubdirs
; gameinfo.gi patches CS2's search paths so the game looks inside addons\ at all,
; and backup\ holds the two variants the Panel's Online / Bot Mode switch copies.
Source: "{#PayloadRoot}\gameinfo.gi"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadRoot}\backup\*"; DestDir: "{app}\backup"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- Panel application ---
Source: "{#PanelExe}"; DestDir: "{app}"; DestName: "{#PanelExeName}"; Flags: ignoreversion skipifsourcedoesntexist

; --- Documentation, which lives in the repository rather than the payload ---
Source: "{#RepoRoot}\Commands.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
; The Panel is PolyForm-licensed, so its own licence must travel with its binary.
Source: "{#RepoRoot}\Panel\LICENSE"; DestDir: "{app}"; DestName: "LICENSE-Panel.txt"; Flags: ignoreversion


; ------------------------------------------------------------------------------
;  Shortcuts
; ------------------------------------------------------------------------------
[Icons]
Name: "{autoprograms}\{#MyAppName}\{#MyAppName} Panel"; Filename: "{app}\{#PanelExeName}"; Check: PanelExeInstalled
Name: "{autodesktop}\{#MyAppName} Panel"; Filename: "{app}\{#PanelExeName}"; Tasks: desktopicon; Check: PanelExeInstalled


; ------------------------------------------------------------------------------
;  Offer to open the Panel once the files are in place
; ------------------------------------------------------------------------------
[Run]
Filename: "{app}\{#PanelExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent; Check: PanelExeInstalled


; ==============================================================================
;  Pascal Script
; ==============================================================================
[Code]
const
  CS2_STEAM_APP   = '730';
  CS2_INSTALL_DIR = 'Counter-Strike Global Offensive';
  CSGO_SUBDIR     = 'game\csgo';

var
  { Memo for the one-per-session CS2 detection sweep. }
  DetectionDone: Boolean;
  DetectedPath: String;


{ ------------------------------------------------------------------ path utils }

function NormalizePath(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '/', '\', True);
  if (Length(Result) > 3) and (Result[Length(Result)] = '\') then
    Delete(Result, Length(Result), 1);
end;

function JoinPath(const A, B: String): String;
begin
  Result := NormalizePath(A) + '\' + B;
end;

function SamePath(const A, B: String): Boolean;
begin
  Result := CompareText(NormalizePath(A), NormalizePath(B)) = 0;
end;

{ Appends Value to List unless it is empty, does not exist, or is already there. }
procedure AddUnique(var List: TArrayOfString; const Value: String);
var
  I: Integer;
begin
  if Value = '' then Exit;
  if not DirExists(Value) then Exit;
  for I := 0 to GetArrayLength(List) - 1 do
    if SamePath(List[I], Value) then Exit;
  SetArrayLength(List, GetArrayLength(List) + 1);
  List[GetArrayLength(List) - 1] := NormalizePath(Value);
end;


{ -------------------------------------------------------------- Steam locating }

{ Steam's own folder, as recorded in the registry. Steam writes SteamPath per
  user, so HKCU is tried first; the machine-wide InstallPath is the fallback, in
  both registry views (a 32-bit installer would otherwise be redirected away from
  the 64-bit one). Returns '' when nothing is recorded — which is common for
  moved or portable Steam installs, and is why the callers have other sources. }
function GetSteamRoot(): String;
var
  P: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\Valve\Steam', 'SteamPath', P) then
  begin
    Result := NormalizePath(P);
    Exit;
  end;
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Valve\Steam', 'InstallPath', P) then
  begin
    Result := NormalizePath(P);
    Exit;
  end;
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Valve\Steam', 'InstallPath', P) then
  begin
    Result := NormalizePath(P);
    Exit;
  end;
end;

{ Pulls the quoted value out of a "path" "D:\\SteamLibrary" VDF line. Walks the
  quotes by chopping the string down instead of using PosEx, which this dialect
  of Pascal Script does not have. }
function ExtractVdfPathValue(const Line: String; var Value: String): Boolean;
var
  S: String;
  Q: Integer;
begin
  Result := False;
  Value := '';
  S := Line;

  { Skip the key, then the opening quote of the value. }
  Q := Pos('"', S);
  if Q < 1 then Exit;
  S := Copy(S, Q + 1, Length(S));
  Q := Pos('"', S);
  if Q < 1 then Exit;
  S := Copy(S, Q + 1, Length(S));
  Q := Pos('"', S);
  if Q < 1 then Exit;
  S := Copy(S, Q + 1, Length(S));

  { Everything up to the closing quote is the path. }
  Q := Pos('"', S);
  if Q < 1 then Exit;
  Value := Copy(S, 1, Q - 1);
  if Value = '' then Exit;

  { VDF escapes separators: "D:\\SteamLibrary" -> "D:\SteamLibrary" }
  StringChangeEx(Value, '\\', '\', True);
  Result := True;
end;

{ Reads every "path" value out of steamapps\libraryfolders.vdf. That file is the
  authoritative list of Steam libraries, so it finds a game installed on any
  drive without guessing. }
procedure AddLibraryPathsFromVdf(const VdfPath: String; var Libs: TArrayOfString);
var
  Lines: TArrayOfString;
  I: Integer;
  Line, Value: String;
begin
  if not FileExists(VdfPath) then Exit;
  if not LoadStringsFromFile(VdfPath, Lines) then Exit;

  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos('"path"', Lowercase(Line)) = 1 then
      if ExtractVdfPathValue(Line, Value) then
        AddUnique(Libs, Value);
  end;
end;

{ Every folder that could be a Steam root: the registry value, then the
  conventional locations on the system drive.

  There is deliberately no sweep across the other drive letters: Pascal Script
  exposes no drive enumeration here, and probing letters directly can block for
  seconds on an empty optical drive or a disconnected network drive. Nothing is
  lost by leaving it out, because reading libraryfolders.vdf from any one Steam
  root already reveals the libraries living on every other drive. }
procedure CollectSteamRoots(var Roots: TArrayOfString);
var
  SystemDrive: String;
begin
  AddUnique(Roots, GetSteamRoot());

  SystemDrive := ExpandConstant('{sd}');
  AddUnique(Roots, SystemDrive + '\Program Files (x86)\Steam');
  AddUnique(Roots, SystemDrive + '\Program Files\Steam');
  AddUnique(Roots, SystemDrive + '\Steam');
end;

{ Every folder that could hold an installed game: each Steam root, every library
  listed in that root's libraryfolders.vdf, and the conventional library folder
  on the system drive. }
procedure CollectLibraries(var Libs: TArrayOfString);
var
  Roots: TArrayOfString;
  I: Integer;
begin
  CollectSteamRoots(Roots);

  for I := 0 to GetArrayLength(Roots) - 1 do
  begin
    AddUnique(Libs, Roots[I]);
    AddLibraryPathsFromVdf(JoinPath(Roots[I], 'steamapps\libraryfolders.vdf'), Libs);
  end;

  AddUnique(Libs, ExpandConstant('{sd}') + '\SteamLibrary');
end;

{ Counter-Strike 2's game\csgo folder, or '' when it cannot be found. A library
  that actually holds appmanifest_730.acf wins first, so a second library
  containing an unrelated copy of the folder cannot shadow the real one. }
function FindCsgoDir(): String;
var
  Libs: TArrayOfString;
  I: Integer;
  Candidate: String;
begin
  Result := '';
  CollectLibraries(Libs);

  for I := 0 to GetArrayLength(Libs) - 1 do
  begin
    if FileExists(JoinPath(Libs[I], 'steamapps\appmanifest_' + CS2_STEAM_APP + '.acf')) then
    begin
      Candidate := JoinPath(Libs[I], 'steamapps\common\' + CS2_INSTALL_DIR + '\' + CSGO_SUBDIR);
      if DirExists(Candidate) then
      begin
        Result := Candidate;
        Exit;
      end;
    end;
  end;

  for I := 0 to GetArrayLength(Libs) - 1 do
  begin
    Candidate := JoinPath(Libs[I], 'steamapps\common\' + CS2_INSTALL_DIR + '\' + CSGO_SUBDIR);
    if DirExists(Candidate) then
    begin
      Result := Candidate;
      Exit;
    end;
  end;
end;

{ Is cs2.exe in the process list? Uses tasklist + find so there is no dependency
  on any helper library; find's exit code is 0 only when the image name matched. }
function IsCs2Running(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if not Exec(ExpandConstant('{cmd}'),
      '/c tasklist /FI "IMAGENAME eq cs2.exe" | find /i "cs2.exe" > nul',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then Exit;
  Result := ResultCode = 0;
end;

{ ------- Setup event handlers ------- }

{ The detection sweep reads the registry and walks every drive, so run it at most
  once per session and remember the answer. }
function DetectCsgoOnce(): String;
begin
  if not DetectionDone then
  begin
    DetectedPath := FindCsgoDir();
    DetectionDone := True;
  end;
  Result := DetectedPath;
end;

{ Supplies DefaultDirName. Points at the conventional location when detection
  fails, so the field is still a sensible starting point. }
function GetDefaultCsgoDir(Param: String): String;
begin
  Result := DetectCsgoOnce();
  if Result = '' then
    Result := ExpandConstant('{sd}\SteamLibrary\steamapps\common\' + CS2_INSTALL_DIR + '\' + CSGO_SUBDIR);
end;

{ Whether the Panel executable made it into the install (it is missing from
  development builds that have not produced one yet). }
function PanelExeInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\{#PanelExeName}'));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpSelectDir then Exit;
  if DetectCsgoOnce() = '' then
    WizardForm.PageDescriptionLabel.Caption := ExpandConstant('{cm:selectdir_notfound}');
end;

{ Installing while CS2 is running means locked plugin DLLs and a half-applied
  install, so make the user acknowledge it. Silent installs skip the prompt. }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID <> wpReady then Exit;
  if WizardSilent() then Exit;
  if not IsCs2Running() then Exit;
  Result := MsgBox(ExpandConstant('{cm:cs2running}'), mbConfirmation, MB_YESNO) = IDYES;
end;
