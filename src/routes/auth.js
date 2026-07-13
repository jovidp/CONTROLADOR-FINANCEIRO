import { Router } from 'express';
import {
  cadastrarUsuario,
  cadastroStatus,
  conferirCredenciais,
  criarToken,
  gravarCookie,
  limparCookie,
  registrarAcerto,
  registrarFalha,
  segundosBloqueado,
  sessaoDe,
} from '../auth.js';
import { asyncHandler, booleano, HttpError, texto } from '../http.js';

const router = Router();

const REQUISITOS_SENHA = 'A senha deve ter de 4 a 60 caracteres.';

function senhaValida(senha) {
  return senha.length >= 4 && senha.length <= 60;
}

/**
 * Unica rota da API que responde sem sessao (junto de /api/health) -- e´ por onde
 * a sessao nasce. O freio de tentativas mora em auth.js.
 */
router.post('/login', asyncHandler(async (req, res) => {
  const espera = segundosBloqueado();
  if (espera > 0) {
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${espera}s.`);
  }

  const usuario = texto(req.body?.usuario, 'usuario', { max: 60 });
  const senha = texto(req.body?.senha, 'senha', { max: 200 });
  const lembrar = booleano(req.body?.lembrar);

  const credencial = await conferirCredenciais(usuario, senha);
  if (!credencial) {
    registrarFalha();
    // Mensagem unica de proposito: dizer "usuario nao existe" entregaria metade
    // da credencial a quem esta chutando.
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }

  registrarAcerto();
  gravarCookie(res, criarToken({ lembrar, usuario: credencial.usuario, usuarioId: credencial.id }), req);
  res.json({ usuario });
}));

router.post('/cadastro', asyncHandler(async (req, res) => {
  const usuario = texto(req.body?.usuario, 'usuario', { max: 60 });
  const senha = texto(req.body?.senha, 'senha', { max: 200 });
  const confirmacao = texto(req.body?.confirmacao, 'confirmacao', { max: 200 });

  if (!/^[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*$/u.test(usuario) || usuario.length < 3 || usuario.length > 60) {
    throw new HttpError(
      400,
      'Usuário deve ter de 3 a 60 caracteres, sem espaços no início/fim nem espaços repetidos.',
      'usuario',
    );
  }
  if (!senhaValida(senha)) {
    throw new HttpError(400, REQUISITOS_SENHA, 'senha');
  }
  if (senha !== confirmacao) {
    throw new HttpError(400, 'As senhas não são iguais.', 'confirmacao');
  }

  try {
    const criado = await cadastrarUsuario(usuario, senha);
    res.status(201).json({ usuario: criado.usuario });
  } catch (err) {
    if (err?.code === '23505' || err?.code === 'CF_USER_EXISTS') {
      throw new HttpError(409, 'Já existe um cadastro. Entre com o usuário e a senha cadastrados.', 'usuario');
    }
    throw err;
  }
}));

router.post('/logout', (req, res) => {
  limparCookie(res, req);
  res.status(204).end();
});

/** Usada pelo frontend no boot: 200 sempre, com ou sem sessao. */
router.get('/sessao', (req, res) => {
  const sessao = sessaoDe(req);
  const valida = Boolean(sessao && Number.isInteger(Number(sessao.id)));
  res.json({
    autenticado: valida,
    usuario: valida ? sessao.u : null,
    expira_em: valida ? new Date(sessao.exp).toISOString() : null,
  });
});

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await cadastroStatus());
}));

export default router;
