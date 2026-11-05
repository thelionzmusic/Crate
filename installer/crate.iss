; Per-user installer: no admin prompt, Start menu + desktop shortcut, clean uninstall.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F3C2A51-8E4B-4C7D-9A1E-5B2D7C8E9F10}
AppName=Crate
AppVersion={#AppVersion}
AppPublisher=Crate
DefaultDirName={localappdata}\Programs\Crate
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=Crate-Setup-{#AppVersion}
SetupIconFile=..\crate\web\icon.ico
UninstallDisplayIcon={app}\Crate.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "..\dist\Crate\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; drop files from older builds so nothing stale lingers
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Crate"; Filename: "{app}\Crate.exe"
Name: "{autodesktop}\Crate"; Filename: "{app}\Crate.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Crate.exe"; Description: "Open Crate"; Flags: nowait postinstall skipifsilent
