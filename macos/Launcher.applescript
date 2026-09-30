on run
  set appPath to POSIX path of (path to me)
  if appPath starts with "/Volumes/ChatGPT Computer/" then
    display dialog "请先把 ChatGPT Computer 拖进“应用程序”文件夹，再从那里打开。" buttons {"好"} default button "好"
    return
  end if
  set runtimePath to appPath & "Contents/Resources/runtime/"
  try
    set managerURL to do shell script quoted form of (runtimePath & "node") & " " & quoted form of (runtimePath & "open-manager.mjs")
    open location managerURL
  on error errorMessage
    display dialog "无法打开本机管理页：" & return & errorMessage buttons {"好"} default button "好" with icon stop
  end try
end run
