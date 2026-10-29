Option Explicit
' ASCII-only in-memory launcher for the silent scenario.
' Arguments: <workingDirectory> <bootstrapMjs> [host arguments...]
Dim shell, workingDirectory, bootstrapPath, command, argsPart, index
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
workingDirectory = StripTrailingSeparator(WScript.Arguments(0))
bootstrapPath = WScript.Arguments(1)
argsPart = ""
For index = 2 To WScript.Arguments.Count - 1
  argsPart = argsPart & " " & QuoteArgument(WScript.Arguments(index))
Next
command = "cmd.exe /d /s /c ""node.exe --input-type=module -" & argsPart & " < " & QuoteArgument(bootstrapPath) & Chr(34)
shell.CurrentDirectory = workingDirectory
shell.Run command, 0, False
WScript.Quit 0

Function QuoteArgument(value)
  Dim text, trailing, count
  text = CStr(value)
  count = 0
  Do While Len(text) > 0 And Right(text, 1) = "\"
    count = count + 1
    text = Left(text, Len(text) - 1)
  Loop
  text = Replace(text, """", "\""")
  If count > 0 Then text = text & String(count * 2, "\")
  QuoteArgument = """" & text & """"
End Function

Function StripTrailingSeparator(value)
  Dim text
  text = CStr(value)
  Do While Len(text) > 3
    If Right(text, 1) <> "\" And Right(text, 1) <> "/" Then Exit Do
    text = Left(text, Len(text) - 1)
  Loop
  StripTrailingSeparator = text
End Function
