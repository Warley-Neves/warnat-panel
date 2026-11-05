# Evolution API v2 + Typebot - Automação Warnat Tech

Projeto completo de atendimento humanizado no WhatsApp e agendamento de visitas técnicas integrando **Evolution API v2**, **PostgreSQL** e **Typebot**.

---

## 🚀 Início Rápido (3 Passos)

### 1. Iniciar os Containers (Evolution API + Postgres)
```powershell
# No Windows PowerShell:
.\scripts\start.ps1

# No Linux VPS:
chmod +x scripts/*.sh
./scripts/start.sh
```

### 2. Criar a Instância e Escanear o QR Code
```powershell
# Cria a instância warnat-tech:
.\scripts\create_instance.ps1

# Abre o QR Code no seu navegador:
.\scripts\connect_instance.ps1
```
*No celular com o WhatsApp da Warnat Tech: abra o WhatsApp > Aparelhos Conectados > Conectar Aparelho e escaneie o código.*

### 3. Vincular o Typebot à Instância
1. No [Typebot](https://typebot.io/), importe o fluxo pronto localizado em `typebot/warnat-tech-typebot.json` e clique em **Publish**.
2. Copie o identificador/slug público do bot gerado e atualize a variável `TYPEBOT_NAME` no arquivo `.env`.
3. Execute o script de vinculação:
```powershell
.\scripts\configure_typebot.ps1
```

---

## 📁 Estrutura de Pastas e Arquivos

| Arquivo / Pasta | Descrição |
| :--- | :--- |
| [MANUAL_DE_IMPLEMENTACAO.md](file:///d:/Projetos/evolution/MANUAL_DE_IMPLEMENTACAO.md) | **Manual mestre completo** cobrindo passo a passo, parâmetros, áudio PTT, webhooks e troubleshooting. |
| [docker-compose.yml](file:///d:/Projetos/evolution/docker-compose.yml) | Definição da stack Docker (PostgreSQL 15 + Evolution API v2.2.2). |
| [.env](file:///d:/Projetos/evolution/.env) / [.env.example](file:///d:/Projetos/evolution/.env.example) | Configuração de variáveis de ambiente, portas, chaves e credenciais. |
| [typebot/warnat-tech-typebot.json](file:///d:/Projetos/evolution/typebot/warnat-tech-typebot.json) | Fluxo completo do Typebot pronto para importação em 1 clique. |
| [api-requests.http](file:///d:/Projetos/evolution/api-requests.http) | Coleção de requisições HTTP para a extensão REST Client do VS Code. |
| [api/evolution-api.postman_collection.json](file:///d:/Projetos/evolution/api/evolution-api.postman_collection.json) | Coleção completa de requisições para importar no Postman ou Insomnia. |
| [audio/roteiro_audio.txt](file:///d:/Projetos/evolution/audio/roteiro_audio.txt) | Roteiro e orientações para gravação do áudio consultivo em formato de nota de voz (PTT). |
| `scripts/` | Scripts de automação para PowerShell (Windows) e Bash (Linux/VPS). |

---

## ⚙️ Scripts de Automação Disponíveis

* `scripts/start.ps1` / `scripts/start.sh`: Inicia todos os containers e valida a saúde do PostgreSQL.
* `scripts/stop.ps1` / `scripts/stop.sh`: Encerra os containers com segurança.
* `scripts/create_instance.ps1` / `scripts/create_instance.sh`: Cria a instância da Warnat Tech via API.
* `scripts/connect_instance.ps1` / `scripts/connect_instance.sh`: Exibe o QR Code para pareamento.
* `scripts/configure_typebot.ps1` / `scripts/configure_typebot.sh`: Vincula o Typebot com simulação de digitação, agrupamento de mensagens e pausa na intervenção humana.
* `scripts/send_test_notification.ps1` / `scripts/send_test_notification.sh`: Dispara um alerta de teste simulando a chegada de um lead quente.
* `scripts/status.ps1` / `scripts/status.sh`: Checa o estado da conexão do WhatsApp e status dos containers.
