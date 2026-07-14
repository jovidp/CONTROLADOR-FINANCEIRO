/** Tela de cadastro e login; cada usuario acessa o seu proprio espaco de dados. */

const cadastroForm = document.getElementById('cadastroForm');
const loginForm = document.getElementById('loginForm');
const loginSub = document.getElementById('loginSub');

const usuarioCadastro = document.getElementById('usuarioCadastro');
const senhaCadastro = document.getElementById('senhaCadastro');
const confirmacaoCadastro = document.getElementById('confirmacaoCadastro');
const campoConvite = document.getElementById('campoConvite');
const conviteCadastro = document.getElementById('conviteCadastro');
const btnCadastrar = document.getElementById('btnCadastrar');
const cadastroErro = document.getElementById('cadastroErro');

const usuario = document.getElementById('usuario');
const senha = document.getElementById('senha');
const lembrar = document.getElementById('lembrar');
const campo2fa = document.getElementById('campo2fa');
const codigo2fa = document.getElementById('codigo2fa');
const btnEntrar = document.getElementById('btnEntrar');
const btnVer = document.getElementById('btnVer');
const erro = document.getElementById('erro');
const sucesso = document.getElementById('sucesso');

const SEM_SERVIDOR = 'Não consegui falar com o servidor. Ele está rodando?';
// Espelha o problemaNaSenha() do servidor -- so´ o tamanho, que e´ o que adianta checar
// aqui. O resto (senhas obvias, senha = usuario) fica so´ no servidor: a checagem do
// navegador e´ conveniencia, e nao defesa; quem ataca nao passa por esta pagina.
const REQUISITOS_SENHA = /^.{12,200}$/;
const MSG_REQUISITOS = 'A senha deve ter pelo menos 12 caracteres.';

function mostrar(box, mensagem) {
  box.textContent = mensagem;
  box.classList.remove('hidden');
}

function limpar(box) {
  box.textContent = '';
  box.classList.add('hidden');
}

function alternarTela(tela) {
  const cadastro = tela === 'cadastro';
  cadastroForm.classList.toggle('hidden', !cadastro);
  loginForm.classList.toggle('hidden', cadastro);
  loginSub.textContent = cadastro ? 'Crie seu cadastro para começar.' : 'Entre para ver suas contas.';

  if (cadastro) {
    limpar(cadastroErro);
    usuarioCadastro.focus();
  } else {
    limpar(erro);
    usuario.focus();
  }
}

function ocupadoCadastro(sim) {
  btnCadastrar.disabled = sim;
  btnCadastrar.textContent = sim ? 'Criando...' : 'Criar cadastro';
}

function ocupadoLogin(sim) {
  btnEntrar.disabled = sim;
  // Com o campo de código à mostra, o botão confirma o 2º fator: "Verificar".
  const parado = campo2fa.classList.contains('hidden') ? 'Entrar' : 'Verificar';
  btnEntrar.textContent = sim ? 'Entrando...' : parado;
}

async function respostaJson(url, opcoes) {
  const resposta = await fetch(url, opcoes);
  const corpo = await resposta.json().catch(() => null);
  return { resposta, corpo };
}

async function cadastrar(ev) {
  ev.preventDefault();
  limpar(cadastroErro);

  if (!cadastroForm.checkValidity()) {
    cadastroForm.reportValidity();
    return;
  }
  if (!REQUISITOS_SENHA.test(senhaCadastro.value)) {
    mostrar(cadastroErro, MSG_REQUISITOS);
    senhaCadastro.focus();
    return;
  }
  if (senhaCadastro.value !== confirmacaoCadastro.value) {
    mostrar(cadastroErro, 'As senhas não são iguais.');
    confirmacaoCadastro.focus();
    return;
  }

  ocupadoCadastro(true);
  try {
    const { resposta, corpo } = await respostaJson('/api/auth/cadastro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuario: usuarioCadastro.value.trim(),
        senha: senhaCadastro.value,
        confirmacao: confirmacaoCadastro.value,
        // Vai sempre; o servidor ignora quando o cadastro é aberto e exige quando não é.
        convite: conviteCadastro.value.trim(),
      }),
    });

    if (!resposta.ok) {
      mostrar(cadastroErro, corpo?.erro || `Erro ${resposta.status} ao criar cadastro.`);
      return;
    }

    usuario.value = usuarioCadastro.value.trim();
    senha.value = '';
    senhaCadastro.value = '';
    confirmacaoCadastro.value = '';
    alternarTela('login');
    mostrar(sucesso, 'Cadastro criado. Agora entre com sua senha.');
    senha.focus();
  } catch {
    mostrar(cadastroErro, SEM_SERVIDOR);
  } finally {
    ocupadoCadastro(false);
  }
}

async function entrar(ev) {
  ev.preventDefault();
  limpar(erro);
  limpar(sucesso);

  if (!loginForm.checkValidity()) {
    loginForm.reportValidity();
    return;
  }

  const exibindo2fa = !campo2fa.classList.contains('hidden');

  ocupadoLogin(true);
  try {
    const { resposta, corpo } = await respostaJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuario: usuario.value.trim(),
        senha: senha.value,
        lembrar: lembrar.checked,
        // Só vai preenchido no 2º envio, quando o campo de código está à mostra.
        codigo: exibindo2fa ? codigo2fa.value.trim() : undefined,
      }),
    });

    // Senha certa, mas a conta tem 2FA: revela o campo de código e espera o 2º envio.
    if (resposta.ok && corpo?.precisa_2fa) {
      campo2fa.classList.remove('hidden');
      codigo2fa.required = true;
      btnEntrar.textContent = 'Verificar';
      codigo2fa.focus();
      return;
    }

    if (!resposta.ok) {
      mostrar(erro, corpo?.erro || `Erro ${resposta.status} ao entrar.`);
      // Erro no código: limpa só o código e mantém o campo aberto. Senão, limpa a senha.
      if (exibindo2fa) { codigo2fa.value = ''; codigo2fa.focus(); } else { senha.value = ''; senha.focus(); }
      return;
    }

    // replace evita que o botão voltar traga a tela de login de volta.
    location.replace('/');
  } catch {
    mostrar(erro, SEM_SERVIDOR);
  } finally {
    ocupadoLogin(false);
  }
}

function alternarVer() {
  const revelada = senha.type === 'text';
  senha.type = revelada ? 'password' : 'text';

  const rotulo = revelada ? 'Mostrar senha' : 'Ocultar senha';
  btnVer.setAttribute('aria-pressed', String(!revelada));
  btnVer.setAttribute('aria-label', rotulo);
  btnVer.title = rotulo;
  senha.focus();
}

async function iniciar() {
  try {
    const { resposta, corpo } = await respostaJson('/api/auth/status');
    if (!resposta.ok) throw new Error(corpo?.erro || 'status');
    // Convite exigido: revela o campo e o torna obrigatório. Escondido, um `required`
    // faria o reportValidity() tentar focar um campo invisível e travar o cadastro.
    if (corpo.convite_exigido) {
      campoConvite.classList.remove('hidden');
      conviteCadastro.required = true;
    }
    alternarTela(corpo.cadastrado ? 'login' : 'cadastro');
  } catch {
    // Se o status falhar, mantém o cadastro como primeiro acesso e informa o
    // erro somente quando o usuário tentar salvar; assim a tela continua útil.
    alternarTela('cadastro');
  }
}

cadastroForm.addEventListener('submit', cadastrar);
loginForm.addEventListener('submit', entrar);
btnVer.addEventListener('click', alternarVer);
document.getElementById('btnIrLogin').addEventListener('click', () => alternarTela('login'));
document.getElementById('btnIrCadastro').addEventListener('click', () => alternarTela('cadastro'));
cadastroForm.addEventListener('input', () => limpar(cadastroErro));
loginForm.addEventListener('input', () => { limpar(erro); limpar(sucesso); });

iniciar();
