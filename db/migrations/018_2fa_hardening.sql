-- =====================================================================
--  Endurecimento do 2FA e das sessões.
-- =====================================================================

-- Anti-replay do TOTP: o MAIOR contador (janela de 30s) já aceito neste usuário.
-- Um código só vale uma vez — reapresentá-lo depois é recusado.
ALTER TABLE usuarios ADD COLUMN totp_ultimo_contador bigint;

-- Revogação de sessão: a versão de token vigente. O token carrega a versão em que
-- nasceu; quando esta sobe (troca de senha, "sair de todos"), todo token com versão
-- menor deixa de valer — sem tabela de sessões, só um inteiro por usuário.
ALTER TABLE usuarios ADD COLUMN token_versao integer NOT NULL DEFAULT 0;
