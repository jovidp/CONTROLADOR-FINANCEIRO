' Sobe o servidor sem abrir janela. Usado pela Tarefa Agendada
' "ControladorFinanceiro", que roda no logon para o Tailscale Serve ter o que
' publicar em https://flp-ws-exp-006.taila22cef.ts.net
'
' Para uso no dia a dia continue abrindo o "Iniciar Controlador.bat": ele mostra
' as mensagens do servidor e abre o navegador. Este script e o contrario -- nao
' fala nada com ninguem, por isso tudo que o servidor escreve vai para
' logs\servidor.log: sem janela, e o unico lugar onde da para ver por que ele
' nao subiu.
'
' O terceiro argumento do Run e True de proposito: o wscript fica vivo enquanto o
' node estiver rodando e devolve o codigo de saida dele. Sem isso a tarefa
' terminaria "com sucesso" no mesmo instante, e o reiniciar-se-falhar do Windows
' nunca veria o servidor cair.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

raiz = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = raiz

If Not fso.FolderExists(fso.BuildPath(raiz, "logs")) Then
  fso.CreateFolder fso.BuildPath(raiz, "logs")
End If

' "log" nao pode ser nome de variavel: e a funcao interna Log() do VBScript
' (logaritmo natural), e atribuir nela da "Atribuicao invalida" em tempo de execucao.
node = """C:\Program Files\nodejs\node.exe"""
arqLog = """" & fso.BuildPath(raiz, "logs\servidor.log") & """"

' cmd /s /c com a linha inteira entre aspas: e o unico jeito de redirecionar a
' saida do node quando o executavel esta num caminho com espaco.
comando = "cmd /s /c """ & node & " src\server.js >> " & arqLog & " 2>&1"""

codigo = sh.Run(comando, 0, True)
WScript.Quit codigo
