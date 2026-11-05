# MANUAL COMPLETO DE IMPLEMENTAÇÃO E AUTOMAÇÃO
## Evolution API v2 + Typebot + WhatsApp Humanizado (Warnat Tech)

---

### Visão Geral da Arquitetura

Este manual descreve a implementação completa, passo a passo e à prova de falhas, da automação de atendimento humanizado e captação de visitas técnicas para a **Warnat Tech**. A solução conecta a **Evolution API v2** (motor de comunicação com o WhatsApp baseado em Baileys) ao **Typebot** (plataforma visual de fluxos conversacionais), garantindo:

1. **Simulação Realista de Digitação**: O cliente vê o status *"digitando..."* antes de cada mensagem de texto.
2. **Envio de Nota de Voz Autêntica (PTT)**: O áudio explicativo é entregue com o ícone verde de microfone do WhatsApp, como se tivesse sido gravado manualmente pelo técnico.
3. **Pausa Automática ao Intervir (`stopBotFromMe`)**: Se um atendente humano responder pelo celular, o bot silencia imediatamente para aquele contato.
4. **Agrupamento Inteligente (`debounceTime`)**: Se o cliente enviar várias mensagens curtas seguidas, o sistema aguarda para responder tudo de uma só vez.
5. **Transbordo Imediato (Lead Quente)**: Ao final do fluxo, um webhook dispara um alerta formatado para o WhatsApp pessoal do responsável técnico com todos os dados coletados.

```
┌─────────────────┐       WhatsApp       ┌────────────────────────┐
│  Cliente Final  │ ◄──────────────────► │ Evolution API v2 (8080)│
└─────────────────┘                      └───────────┬────────────┘
                                                     │
                                   Webhooks / Baileys│ PostgreSQL (5432)
                                                     ▼
                                         ┌────────────────────────┐
                                         │  Typebot (Cloud/Viewer)│
                                         │  - Acolhimento         │
                                         │  - Triagem Condicional │
                                         │  - Áudio PTT           │
                                         │  - Coleta de Dados     │
                                         └───────────┬────────────┘
                                                     │
                                     Webhook Disparo │ POST /message/sendText
                                                     ▼
                                         ┌────────────────────────┐
                                         │ WhatsApp do Técnico    │
                                         │ (Alerta de Lead Quente)│
                                         └────────────────────────┘
```

---

## 1. Pré-Requisitos e Ambiente

### 1.1. Requisitos de Máquina
* **Sistema Operacional**: Windows 10/11 com Docker Desktop OU Linux VPS (Ubuntu 20.04/22.04 LTS recomendado).
* **Recursos Mínimos**: 1 vCPU, 2 GB de memória RAM, 10 GB de disco livre.
* **Softwares Necessários**:
  * [Docker](https://docs.docker.com/get-docker/) e [Docker Compose](https://docs.docker.com/compose/) instalados e ativos.
  * Conta ativa no [Typebot Cloud](https://typebot.io/) (ou instância auto-hospedada).
  * Um número de WhatsApp para a empresa (instância Warnat Tech) e outro para receber os alertas.

### 1.2. Portas e Rede
* **Porta 8080**: Porta padrão da Evolution API.
  > [!NOTE]
  > Se você já tiver outro serviço escutando na porta `8080` (ex: Apache `httpd` ou Tomcat), basta abrir o arquivo `.env` e alterar para `EVOLUTION_PORT=8085` (ou outra de sua escolha). O `docker-compose.yml` mapeará automaticamente.
* **Porta 5432**: Usada internamente pelo container PostgreSQL. Ela não precisa ser exposta para a internet.
* **Atenção sobre Typebot Cloud e Localhost**:
  * O Typebot Cloud roda nos servidores da internet. Para que ele consiga acionar o webhook final de volta para a Evolution API, a URL da Evolution API deve ser acessível publicamente (IP público da VPS com porta liberada, domínio com SSL, ou túnel seguro como [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) ou [ngrok](https://ngrok.com/)).
  * Se estiver apenas testando em ambiente 100% local, utilize ngrok (`ngrok http 8080`) ou crie uma VPS.

---

## 2. Instalação e Subida da Evolution API (via Docker Compose)

A Evolution API necessita do banco de dados relacional **PostgreSQL** para armazenar metadados, sessões, instâncias e logs de comunicação.

### 2.1. Estrutura de Arquivos do Projeto
Na raiz do projeto (`d:\Projetos\evolution`), você encontrará a seguinte estrutura:

```
evolution/
├── .env                              # Variáveis de ambiente com chaves e senhas
├── .env.example                      # Modelo com explicações de cada variável
├── .gitignore                        # Protege credenciais de versionamento
├── docker-compose.yml                # Configuração dos serviços Postgres e Evolution API
├── api-requests.http                 # Requisições prontas para VS Code REST Client
├── MANUAL_DE_IMPLEMENTACAO.md        # Este manual completo
├── README.md                         # Guia rápido de introdução
├── api/
│   └── evolution-api.postman_collection.json  # Coleção completa para Postman/Insomnia
├── audio/
│   └── roteiro_audio.txt             # Roteiro e dicas para gravação do áudio consultivo
├── scripts/
│   ├── start.ps1 / start.sh          # Inicialização dos containers
│   ├── stop.ps1 / stop.sh            # Parada dos containers
│   ├── create_instance.ps1 / .sh     # Criação da instância Warnat Tech
│   ├── connect_instance.ps1 / .sh    # Conexão e abertura do QR Code
│   ├── configure_typebot.ps1 / .sh   # Vinculação completa com Typebot
│   ├── send_test_notification.ps1 / .sh # Teste do webhook de alerta
│   └── status.ps1 / status.sh        # Diagnóstico de integridade e conexão
└── typebot/
    └── warnat-tech-typebot.json      # Fluxo completo pronto para importação
```

### 2.2. O Arquivo `docker-compose.yml`
O arquivo `docker-compose.yml` define os serviços `postgres` e `evolution-api`. As credenciais e portas são carregadas dinamicamente a partir do `.env`:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: evolution_postgres
    restart: always
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-evolution_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sua_senha_forte_aqui}
      POSTGRES_DB: ${POSTGRES_DB:-evolution_db}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - evolution_network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-evolution_user} -d ${POSTGRES_DB:-evolution_db}"]
      interval: 5s
      timeout: 5s
      retries: 5

  evolution-api:
    image: evoapicloud/evolution-api:${EVOLUTION_VERSION:-v2.2.2}
    container_name: evolution_api
    restart: always
    ports:
      - "${EVOLUTION_PORT:-8080}:8080"
    environment:
      - SERVER_URL=${SERVER_URL:-http://localhost:8080}
      - AUTHENTICATION_API_KEY=${AUTHENTICATION_API_KEY:-SUA_CHAVE_GLOBAL_AQUI_123456}
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://${POSTGRES_USER:-evolution_user}:${POSTGRES_PASSWORD:-sua_senha_forte_aqui}@postgres:5432/${POSTGRES_DB:-evolution_db}?schema=public
      - DATABASE_CONNECTION_CLIENT_NAME=evolution_v2
      - DATABASE_SAVE_DATA_INSTANCE=true
      - DATABASE_SAVE_DATA_NEW_MESSAGE=true
      - DATABASE_SAVE_MESSAGE_UPDATE=true
      - DATABASE_SAVE_DATA_CONTACTS=true
      - DATABASE_SAVE_DATA_CHATS=true
      - CACHE_REDIS_ENABLED=false
      - DELAY_MESSAGE=1000
      - AUTO_READ_MESSAGE=false
      - REJECT_CALLS=false
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - evolution_instances:/evolution/instances
    networks:
      - evolution_network

volumes:
  pgdata:
  evolution_instances:

networks:
  evolution_network:
    driver: bridge
```

### 2.3. Inicialização dos Containers
Abra o terminal (PowerShell no Windows ou Terminal no Linux) dentro da pasta `d:\Projetos\evolution`:

#### No Windows (PowerShell):
```powershell
.\scripts\start.ps1
```
*Ou diretamente via Docker Compose:*
```powershell
docker compose up -d
```

#### No Linux (Bash):
```bash
chmod +x scripts/*.sh
./scripts/start.sh
```

### 2.4. Validação da Execução
Execute o comando:
```bash
docker compose ps
```
Você deverá ver ambos os containers com status `Up`:
- `evolution_postgres` (healthy)
- `evolution_api` (Up)

Para acompanhar os logs de inicialização da Evolution API:
```bash
docker compose logs -f evolution-api
```
Quando surgir a mensagem informando que a aplicação está ouvindo na porta 8080 (`Listening on port 8080`), a API estará 100% pronta.

---

## 3. Criação da Instância e Conexão do WhatsApp

Com a Evolution API rodando, crie a instância exclusiva da **Warnat Tech** e emparelhe o aparelho celular via QR Code.

### 3.1. Criar a Instância via Requisição HTTP

Você pode rodar o script automático ou fazer a requisição manual.

#### Opção A: Via Script Automatizado
* **No Windows**: `.\scripts\create_instance.ps1`
* **No Linux**: `./scripts/create_instance.sh`

#### Opção B: Via cURL / Terminal
```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: SUA_CHAVE_GLOBAL_AQUI_123456" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "warnat-tech",
    "token": "token-interno-warnat-123",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

#### Opção C: Via VS Code (REST Client)
Abra o arquivo [api-requests.http](file:///d:/Projetos/evolution/api-requests.http) e clique em **Send Request** na requisição `3. Criar a Instância Warnat Tech`.

A resposta retornará:
```json
{
  "instance": {
    "instanceName": "warnat-tech",
    "instanceId": "...",
    "status": "created"
  },
  "hash": { ... },
  "qrcode": {
    "base64": "data:image/png;base64,iVBORw0KGgo...",
    "code": "..."
  }
}
```

### 3.2. Conectar o Aparelho (Escanear o QR Code)

1. Abra seu navegador web e acesse a URL da instância:
   ```
   http://localhost:8080/instance/connect/warnat-tech
   ```
   *(Ou execute `.\scripts\connect_instance.ps1` para abrir automaticamente no navegador).*
2. A tela exibirá o QR Code gerado em tempo real.
3. No smartphone com o WhatsApp da Warnat Tech:
   - Abra o **WhatsApp**.
   - Toque no menu de três pontos (Android) ou em **Configurações / Ajustes** (iPhone).
   - Selecione **Aparelhos Conectados**.
   - Toque em **Conectar um aparelho**.
   - Aponte a câmera para o QR Code na tela do computador.
4. Aguarde alguns segundos até o WhatsApp sincronizar.

### 3.3. Conferir se a Conexão Foi Estabelecida
Execute o script de diagnóstico:
```powershell
.\scripts\status.ps1
```
Ou envie um `GET` para `http://localhost:8080/instance/connectionState/warnat-tech`:
A resposta deverá indicar:
```json
{
  "instance": {
    "instanceName": "warnat-tech",
    "state": "open"
  }
}
```
> [!IMPORTANT]
> O estado `"open"` confirma que a sessão do WhatsApp está conectada e pronta para receber e enviar mensagens.

---

## 4. Construção do Fluxo no Typebot

Você tem duas formas de configurar o Typebot:
* **Método 1 (Instantâneo)**: Importar o template JSON pré-configurado já criado neste projeto.
* **Método 2 (Passo a Passo Manual)**: Criar os blocos na interface gráfica do Typebot do zero.

---

### Método 1: Importação em 1 Clique (Recomendado)

1. Acesse o [Typebot](https://typebot.io/) e faça login.
2. Na página inicial dos seus bots, clique no botão **Create a typebot** (ou **Import a typebot**).
3. Selecione a opção **Import from a file**.
4. Selecione o arquivo localizado neste repositório:
   `d:\Projetos\evolution\typebot\warnat-tech-typebot.json`
5. O fluxo será carregado imediatamente com todas as mensagens, botões, variáveis, condições e bloco de webhook prontos!
6. Clique no botão azul **Publish** (Publicar) no canto superior direito.
7. Anote o **Slug** ou **ID público** (o identificador ao final da URL de compartilhamento, ex: `warnat-atendimento-xyz`).

---

### Método 2: Construção Manual Bloco a Bloco

Caso queira construir ou personalizar cada detalhe visualmente, siga o roteiro a seguir:

```
[Início]
  │
  ▼
[Wait 2s] ──► [Texto 1] ──► [Wait 2s] ──► [Texto 2 + Botões: Empresa / Casa]
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         ▼                                                                   ▼
    [Se Empresa]                                                         [Se Casa]
         │                                                                   │
         └─────────────────────────────────┬─────────────────────────────────┘
                                           │
                                           ▼
                                   [Pergunta Problema]
                                           │
                                           ▼
                                [Wait 4s + Áudio Gravado PTT]
                                           │
                                           ▼
                                   [Pergunta Bairro]
                                           │
                                           ▼
                                 [Botões: Manhã / Tarde]
                                           │
                                           ▼
                                 [Coleta Nome e Endereço]
                                           │
                                           ▼
                               [Webhook de Alerta Interno]
```

#### Bloco 1: Acolhimento e Segmentação
1. Adicione um bloco `Logic` > `Wait`: configure para **2 segundos**.
2. Adicione um bloco `Bubble` > `Text`:
   > *"Opa, tudo bem? Aqui é da equipe técnica da Warnat Tech."*
3. Adicione outro bloco `Logic` > `Wait`: configure para **2 segundos**.
4. Adicione um bloco `Bubble` > `Text`:
   > *"Vi sua mensagem aqui. Para eu já te direcionar certinho: você precisa de atendimento para a sua empresa ou para a sua residência?"*
5. Adicione um bloco `Inputs` > `Buttons`:
   - Botão 1: `Para minha empresa`
   - Botão 2: `Para minha residência`
   - Clique em **Save answer in variable** e crie a variável: `ambiente`.

#### Bloco 2: Triagem Condicional do Problema
1. Conecte cada botão a uma mensagem de validação correspondente:
   - Saída de *Para minha empresa* -> Bloco `Bubble` > `Text`:
     > *"Show. Ambiente corporativo exige estabilidade total para a operação não parar."*
   - Saída de *Para minha residência* -> Bloco `Bubble` > `Text`:
     > *"Perfeito, com certeza conseguimos resolver isso para você."*
2. Conecte ambas as ramificações a um bloco unificado de `Inputs` > `Text Input`:
   > *"Me conta resumidamente: qual serviço você precisa ou o que está acontecendo? (Ex: rede instável, cabeamento, câmeras, etc.)"*
   - Salve a resposta na variável: `problema`.

#### Bloco 3: O Áudio Consultivo Humanizado
1. Adicione um bloco `Logic` > `Wait` configurado para **4 a 5 segundos** (isso dá a impressão de que o técnico ouviu o áudio ou leu a mensagem e está gravando uma resposta).
2. Adicione um bloco `Bubble` > `Audio`:
   - Faça o upload do arquivo `.mp3` gravado conforme as instruções de [audio/roteiro_audio.txt](file:///d:/Projetos/evolution/audio/roteiro_audio.txt).
   - **Roteiro gravado**:
     > *"Opa, escutei aqui o seu relato. Olha, esse tipo de diagnóstico varia muito dependendo do layout do imóvel, tipo de cabeamento e o que já tem instalado. Para não te passar nenhuma estimativa equivocada e garantir que fique tudo 100%, o ideal é um técnico nosso dar uma olhada presencial no local antes de fechar qualquer orçamento."*

#### Bloco 4: Ancoragem de Rota e Alternativa Dupla
1. Adicione o bloco `Inputs` > `Text Input`:
   > *"Qual é o seu bairro ou região aqui na cidade? Só para eu conferir a rota técnica da equipe."*
   - Salve a resposta na variável: `bairro`.
2. Adicione um bloco `Logic` > `Wait` configurado para **2 segundos**.
3. Adicione o bloco `Bubble` > `Text`:
   > *"Maravilha, estamos com atendimentos nessa região esta semana."*
4. Adicione o bloco `Inputs` > `Buttons`:
   - Texto de pergunta:
     > *"Consigo encaixar uma vistoria de avaliação no seu local. Para você, fica melhor na parte da manhã ou da tarde?"*
   - Botão 1: `Prefiro pela manhã`
   - Botão 2: `Prefiro pela tarde`
   - Salve na variável: `periodo`.

#### Bloco 5: Dados Finais e Encerramento
1. Adicione o bloco `Inputs` > `Text Input`:
   > *"Combinado. Me informe seu nome completo e o endereço (com número) para eu já reservar esse espaço na agenda técnica."*
   - Salve na variável: `dados_finais`.
2. Adicione o bloco `Bubble` > `Text`:
   > *"Perfeito! Já registrei aqui. O técnico responsável pela rota vai te chamar por este mesmo número em instantes só para alinhar o horário exato de chegada. Valeu!"*

#### Bloco 6: Webhook de Transbordo (Notificação Imediata)
Logo após a mensagem de confirmação, adicione o bloco `Logic` > `Webhook`:
- **Method**: `POST`
- **URL**: `http://SEU_IP_OU_DOMINIO:8080/message/sendText/warnat-tech`
- **Headers**:
  - `apikey`: `SUA_CHAVE_GLOBAL_AQUI_123456`
  - `Content-Type`: `application/json`
- **Body**:
  ```json
  {
    "number": "5531999999999",
    "text": "🚨 *NOVO AGENDAMENTO DE VISITA - WARNAT TECH*\n\n*Tipo:* {{ambiente}}\n*Problema:* {{problema}}\n*Bairro:* {{bairro}}\n*Período:* {{periodo}}\n*Dados do Cliente:* {{dados_finais}}"
  }
  ```
  *(Substitua `5531999999999` pelo WhatsApp com DDI + DDD + número que receberá o alerta).*

3. Clique em **Publish** no canto superior direito e copie o **Slug / ID público** do bot (ex: `warnat-atendimento-xyz`).

---

## 5. Integração da Evolution API com o Typebot

Agora amarre a instância `warnat-tech` ao robô criado no Typebot.

### 5.1. Execução via Script
* **No Windows**: `.\scripts\configure_typebot.ps1`
* **No Linux**: `./scripts/configure_typebot.sh`

### 5.2. Execução via Chamada HTTP Direta
Envie uma requisição `POST` para `http://localhost:8080/typebot/set/warnat-tech`:

**Headers:**
```http
apikey: SUA_CHAVE_GLOBAL_AQUI_123456
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "enabled": true,
  "url": "https://viewer.typebot.io",
  "typebot": "warnat-atendimento-xyz",
  "expire": 20,
  "keywordFinish": "#parar",
  "delayMessage": 1500,
  "unknownMessage": "Desculpe, não compreendi. Poderia repetir?",
  "listeningFromMe": false,
  "stopBotFromMe": true,
  "keepOpen": false,
  "debounceTime": 10
}
```

### 5.3. Significado Detalhado de Cada Parâmetro

| Parâmetro | Valor Configurado | O que faz no WhatsApp |
| :--- | :--- | :--- |
| `enabled` | `true` | Ativa a integração do Typebot na instância. |
| `url` | `https://viewer.typebot.io` | URL base do Typebot onde o bot está hospedado. |
| `typebot` | `warnat-atendimento-xyz` | O identificador/slug público do seu fluxo criado no Typebot. |
| `listeningFromMe` | `false` | **Fundamental**: O bot NÃO reage a mensagens enviadas por você mesmo no chat. |
| `stopBotFromMe` | `true` | **Transbordo transparente**: Se você ou sua equipe abrir o WhatsApp e responder manualmente ao cliente, o robô para de responder para aquele contato. |
| `expire` | `20` | Se o cliente parar de responder por 20 minutos, a sessão é encerrada. Se ele mandar mensagem no dia seguinte, inicia um novo atendimento limpo. |
| `keywordFinish` | `#parar` | Palavra de escape. Se o cliente ou atendente digitar `#parar`, o bot é desativado na conversa. |
| `delayMessage` | `1500` | Simula a presença do técnico digitando por 1,5 segundos antes de cada envio, tornando o contato natural. |
| `debounceTime` | `10` | Se o cliente mandar 3 mensagens picadas em menos de 10 segundos, o bot agrupa tudo antes de processar. |
| `unknownMessage` | *(texto amigável)* | Mensagem de fallback amigável caso o usuário digite algo não reconhecido em perguntas de múltipla escolha. |

---

## 6. Configuração e Teste do Webhook de Alerta (Transbordo)

O webhook é o mecanismo que avisa você no mesmo segundo em que o lead encerra o cadastro.

### 6.1. Como o Webhook Opera
Quando o Typebot atinge o último bloco:
1. Ele substitui as variáveis `{{ambiente}}`, `{{problema}}`, `{{bairro}}`, `{{periodo}}` e `{{dados_finais}}` com as respostas do cliente.
2. Faz um disparo HTTP POST direto para a Evolution API:
   `POST /message/sendText/warnat-tech`
3. A Evolution API processa a solicitação e envia imediatamente a mensagem formatada para o número configurado em `number`.

### 6.2. Testando o Disparo de Alerta Agora Mesmo
Para validar que o envio de mensagens está funcionando perfeitamente antes mesmo de rodar o Typebot:

#### No Windows:
```powershell
.\scripts\send_test_notification.ps1
```

#### No Linux:
```bash
./scripts/send_test_notification.sh
```

Você receberá imediatamente em seu WhatsApp uma mensagem de teste como esta:
```
🚨 *NOVO AGENDAMENTO DE VISITA - WARNAT TECH*

*Tipo:* Para minha empresa (TESTE)
*Problema:* Cabeamento estruturado e lentidão de rede
*Bairro:* Centro Empresarial
*Período:* Prefiro pela manhã
*Dados do Cliente:* João Silva - Av. Paulista, 1000 - Sala 402
```

---

## 7. Roteiro de Teste Prático e Validação de Ponta a Ponta

Para homologar a automação completa como se fosse um cliente real:

1. **Inicie o Teste**: Com outro aparelho de celular (ou o número de um colega), envie uma mensagem simples como `"Olá, boa tarde"` para o WhatsApp da Warnat Tech.
2. **Observe o Delay e a Digitação**:
   - Note que o WhatsApp exibirá o status *"digitando..."* por cerca de 2 segundos antes de enviar o primeiro texto.
3. **Responda à Opção de Segmentação**:
   - Toque em `"Para minha empresa"` ou `"Para minha residência"`.
   - Observe a resposta contextual e personalizada de acordo com a opção escolhida.
4. **Relate o Problema Técnico**:
   - Digite uma descrição breve: *"A internet cai toda hora no escritório e as câmeras ficam travando."*
5. **Verifique a Entrega do Áudio (PTT)**:
   - Observe uma pausa de cerca de 4 segundos (tempo simulado de leitura e gravação).
   - O áudio chegará com a **onda sonora e o ícone de microfone verde**. Não aparece como anexo de arquivo, e sim como áudio gravado na hora!
6. **Informe o Bairro e Selecione o Período**:
   - Digite o bairro e selecione entre Manhã ou Tarde.
7. **Informe os Dados Finais**:
   - Digite nome completo e endereço.
8. **Verifique o Transbordo**:
   - O bot enviará a mensagem de despedida e agradecimento.
   - Em menos de 2 segundos, o seu WhatsApp pessoal de técnico/diretoria receberá a notificação com todos os dados do lead prontos para o técnico entrar em contato e fechar a visita!

---

## 8. Guia de Solução de Problemas (Troubleshooting)

### 8.1. "Falha ao subir container: port 8080 is already allocated"
* **Causa**: Outro programa (Apache, IIS, Jenkins ou outro container) já está usando a porta 8080 no seu computador.
* **Solução**:
  1. Abra o arquivo `.env`.
  2. Modifique `EVOLUTION_PORT=8080` para `EVOLUTION_PORT=8085`.
  3. Modifique `SERVER_URL=http://localhost:8085`.
  4. Rode `docker compose up -d`.

### 8.2. "O Webhook do Typebot Cloud não envia o alerta para minha máquina local"
* **Causa**: O Typebot Cloud roda na nuvem e não consegue alcançar `http://localhost:8080` do seu computador residencial/empresarial sem uma rota pública.
* **Solução**:
  - Em produção na VPS: Use o IP público da VPS ou seu subdomínio (ex: `https://evolution.warnat.com.br`).
  - Em testes locais: Instale o [ngrok](https://ngrok.com/) e execute `ngrok http 8080`. Use a URL gerada pelo ngrok (ex: `https://xxxx.ngrok-free.app/message/sendText/warnat-tech`) dentro do bloco Webhook do Typebot.

### 8.3. "O bot parou de responder após eu enviar uma mensagem pelo meu celular"
* **Causa**: Esse é o comportamento planejado do recurso `stopBotFromMe: true`. Quando você digita no chat pelo celular, a Evolution API assume que um humano assumiu o controle e pausa o robô para evitar conversas sobrepostas.
* **Como reativar**: O bot voltará a atender o contato após o período configurado de expiração (`expire: 20` minutos) ou quando o cliente reiniciar a conversa após a sessão expirar.

### 8.4. "Como reiniciar os containers do zero limpando banco e instâncias?"
Se precisar recomeçar uma instalação 100% limpa:
```powershell
docker compose down -v
docker compose up -d
```
*(O parâmetro `-v` remove os volumes persistentes `pgdata` e `evolution_instances`).*

---

## 9. Manutenção e Boas Práticas em Produção

1. **Backup Regular do Banco de Dados**:
   Para realizar backup do banco de instâncias da Evolution API:
   ```bash
   docker exec -t evolution_postgres pg_dump -U evolution_user evolution_db > backup_evolution.sql
   ```
2. **Atualização da Imagem da Evolution API**:
   Quando a equipe da Evolution lançar novas versões:
   - Altere `EVOLUTION_VERSION=v2.x.x` no `.env`.
   - Execute:
     ```bash
     docker compose pull evolution-api
     docker compose up -d
     ```
3. **Aquecimento do Chip (Anti-Ban)**:
   - Não dispare centenas de mensagens ativas para números que nunca falaram com você.
   - Deixe o Typebot responder apenas a **mensagens receptivas** (leads que chamaram a empresa primeiro através de anúncios ou site).
   - O uso de `delayMessage: 1500`, áudio PTT e botões reduz drasticamente qualquer risco de bloqueio junto ao WhatsApp.


---

## 10. Painel Multi-Tenant & Gestão de Múltiplas Contas (Segurança com Senha)

Para gerenciar múltiplas operações e clientes simultaneamente sem que nenhum atendimento ou dado se misture, o projeto conta com um **Painel Administrativo Multi-Tenant**.

* **URL de Acesso:** `http://localhost:3100`
* **Senha Administrativa Master Padrão:** `WarnatAdmin2026!`
* **Alteração de Senha:** Definida no arquivo `.env` na variável `PANEL_ADMIN_PASSWORD`.

### 10.1. Como Funciona a Blindagem Multi-Tenant
1. **Banco de Dados Isolado (Chatwoot Accounts):** Cada operação cadastrada recebe um `Account ID` exclusivo no Chatwoot. Atendentes de um tenant não possuem visibilidade nem acesso às mensagens de outros tenants.
2. **Sessões Isoladas de WhatsApp (Evolution API):** Cada número roda com credenciais e chaves criptográficas em diretórios independentes.
3. **Webhooks Dedicados:** As respostas dos atendentes no Chatwoot saem exclusivamente pelo número de WhatsApp da respectiva operação.
4. **Leitor de QR Code ao Vivo:** Permite escanear e conectar novos números em tempo real diretamente pelo navegador com atualização automática.
5. **Automação IA Individual:** Cada operação pode ter seu próprio Typebot configurado ou operar apenas com atendimento humano.
