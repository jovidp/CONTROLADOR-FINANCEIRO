/**
 * ESLint — a unica dependencia de desenvolvimento do projeto.
 *
 * O app em si continua sem build step e sem framework: isto roda no `npm run lint` e
 * no CI, nunca no navegador nem no servidor. Nada aqui vira arquivo servido.
 *
 * A configuracao e´ curta de proposito. O objetivo nao e´ impor estilo (o codigo ja´ tem
 * um, e e´ consistente) -- e´ pegar a classe de erro que este projeto REALMENTE cometeu:
 * a funcao `cor()` de metas.js, que existia, parecia certa e nunca rodava porque um
 * `const cor` no handler a sombreava. `no-shadow` teria apontado isso no primeiro save.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  {
    // Backend e scripts: Node, ES modules.
    files: ['src/**/*.js', 'test/**/*.js', '.github/scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // O bug do `const cor` sombreando a funcao cor(). Custou uma validacao inteira,
      // que ficou no arquivo por meses sem nunca executar.
      'no-shadow': 'error',

      // NAO usamos `require-await`: ele acusa `async function f() { return withTransaction(...) }`,
      // que e´ o padrao normal aqui -- a funcao devolve a Promise de outra, sem precisar
      // de await proprio. A regra pediria ou tirar o `async` (mudando a assinatura) ou
      // por um await inutil. Nenhum dos dois melhora nada.

      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      // ignoreReadBeforeAssign: o toast() declara `let temporizador`, define o `remover()`
      // que o LE (por closure), e so´ entao atribui o setTimeout. A ordem e´ obrigatoria --
      // um `const` ali nao compila. Sem esta opcao a regra manda trocar por const e quebra.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-var': 'error',
    },
  },

  {
    // Frontend: navegador, ES modules nativos (sem bundler).
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-shadow': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      // ignoreReadBeforeAssign: o toast() declara `let temporizador`, define o `remover()`
      // que o LE (por closure), e so´ entao atribui o setTimeout. A ordem e´ obrigatoria --
      // um `const` ali nao compila. Sem esta opcao a regra manda trocar por const e quebra.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-var': 'error',

      // O frontend inteiro monta DOM com createElement + textNode (o el() do ui.js).
      // innerHTML com nome de categoria ou descricao de transacao -- texto que o usuario
      // digita -- seria XSS. A regra existe para que a proxima pessoa nao reintroduza o
      // atalho sem perceber.
      'no-restricted-properties': ['error',
        { property: 'innerHTML', message: 'Use el() do ui.js: innerHTML com dado do banco é XSS.' },
        { property: 'outerHTML', message: 'Use el() do ui.js: outerHTML com dado do banco é XSS.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'Use toast() do ui.js.' },
        { name: 'confirm', message: 'Use confirmar() do ui.js.' },
      ],
    },
  },

  {
    ignores: ['node_modules/', 'backups/', 'logs/'],
  },
];
