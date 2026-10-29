Option Explicit
' ASCII-only launcher: start the Node host without any visible console window.
' Windows cmd would show a console for node.exe; wscript.exe is a GUI subsystem
' host, so a hidden window style keeps the Node process in the background.
' Arguments: <workingDirectory> <scriptPath> [host arguments...]
' Used by start-windows-silent.cmd for the initial launch. The host also hides
' its own console (--hide-console) so UAC-elevated instances stay hidden.
' WSH parses WScript.Arguments with its own legacy rules: embedded double quotes
' are not preserved, so this launcher must only receive the fixed host flag and
' %~dp0-derived paths (paths may contain spaces). Trailing separators are
' normalized and quoted before WScript.Shell.Run.

Dim shell, workingDirectory, scriptPath, command, index
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If

workingDirectory = StripTrailingSeparator(WScript.Arguments(0))
scriptPath = WScript.Arguments(1)
command = "node.exe " & QuoteArgument(scriptPath)

For index = 2 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

shell.CurrentDirectory = workingDirectory
' Window style 0 = hidden; do not wait, so the calling cmd window can close immediately.
shell.Run command, 0, False
WScript.Quit 0

' Windows argparse treats a backslash before a closing quote as an escaped
' quote, so a trailing backslash (e.g. a path with trailing slash) must be
' doubled. Embedded double quotes are escaped by doubling as well.
Function QuoteArgument(value)
  Dim text, trailing, count
  text = CStr(value)
  count = 0
  Do While Len(text) > 0 And Right(text, 1) = "\"
    count = count + 1
    text = Left(text, Len(text) - 1)
  Loop
  ' CreateProcess/CommandLineToArgvW escape an embedded double quote with a
  ' backslash; trailing backslashes are doubled before the closing quote.
  text = Replace(text, """", "\""")
  If count > 0 Then text = text & String(count * 2, "\")
  QuoteArgument = """" & text & """"
End Function

' Passing a trailing separator as the working directory is harmless for
' WScript.Shell.CurrentDirectory, but normalizing keeps the child cwd stable.
Function StripTrailingSeparator(value)
  Dim text
  text = CStr(value)
  Do While Len(text) > 3
    If Right(text, 1) <> "\" And Right(text, 1) <> "/" Then
      Exit Do
    End If
    text = Left(text, Len(text) - 1)
  Loop
  StripTrailingSeparator = text
End Function
