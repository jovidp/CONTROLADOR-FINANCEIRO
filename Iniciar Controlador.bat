@echo off
title Controlador Financeiro
cd /d "%~dp0"

echo.
echo   Iniciando o Controlador Financeiro...
echo.

sc query postgresql-x64-18 | find "RUNNING" >nul
if errorlevel 1 (
  echo   [!] O servico do PostgreSQL nao esta rodando.
  echo       Tentando iniciar...
  net start postgresql-x64-18
  if errorlevel 1 (
    echo.
    echo   [X] Nao consegui iniciar o PostgreSQL. Abra o "Servicos" do Windows,
    echo       procure por postgresql-x64-18 e inicie manualmente.
    echo.
    pause
    exit /b 1
  )
)

rem Primeira vez (ou .env sem login): pergunta usuario e senha antes de subir.
rem Sem isso o servidor recusaria a subir e a janela fecharia sem explicar nada.
rem O "." no fim do padrao exige pelo menos um caractere depois do "=": assim um
rem AUTH_SENHA_HASH= vazio conta como "sem login", igual a linha nao existir.
findstr /b /r /c:"AUTH_SENHA_HASH=." .env >nul 2>&1
if errorlevel 1 (
  echo   Primeiro acesso: vamos criar o login.
  echo.
  node src\scripts\senha.js
  if errorlevel 1 (
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem Abre o navegador depois do Node iniciar, evitando uma pagina vazia/sem CSS
rem quando o banco demora alguns segundos para responder.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3001'"
node src/server.js
set CODIGO=%errorlevel%

echo.
if "%CODIGO%"=="0" (
  echo   Pode fechar esta janela.
) else (
  echo   [X] O servidor nao subiu. Veja a mensagem acima para saber o motivo.
)
pause
