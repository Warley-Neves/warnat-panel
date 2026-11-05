# Guia de Configuração: Integração Google Calendar (WarNat Tech)

Este guia orienta o passo a passo para conectar o Assistente Virtual (WhatsApp/Typebot) à sua **Google Agenda** pessoal ou corporativa. O sistema verifica horários ocupados em tempo real e impede qualquer agendamento duplicado.

---

## Como o Sistema Funciona

```mermaid
sequenceDiagram
    autonumber
    actor Cliente as Cliente (WhatsApp)
    participant IA as IA (Typebot / GPT-4o mini)
    participant Backend as Módulo Node.js (Porta 3100)
    participant GCal as Google Calendar API

    Cliente->>IA: "Pode ser sexta-feira às 14h? Meu nome é Carlos"
    IA->>Backend: POST /api/calendar/book (data: 2026-11-06, hora: 14:00, Carlos, Betânia)
    Backend->>GCal: freebusy.query (Verifica intervalo 14h às 15h30)
    
    alt Horário já Ocupado
        GCal-->>Backend: [Busy: 14:00 - 15:30]
        Backend-->>IA: 409 Conflict (conflito: true, horários livres: [10:00, 16:00])
        IA-->>Cliente: "Carlos, o horário das 14h já está ocupado. Temos disponível às 10h ou às 16h. Qual fica melhor para você?"
    else Horário Livre
        GCal-->>Backend: [Free / Disponível]
        Backend->>GCal: events.insert (Cria evento verde [Visita Técnica] Carlos)
        GCal-->>Backend: Evento Criado (ID, Link)
        Backend-->>IA: 201 Created (sucesso: true)
        IA-->>Cliente: "Perfeito, Carlos! Sua visita técnica gratuita está confirmada para sexta-feira às 14h no Betânia. O técnico Warley estará no local!"
    end
```

---

## Passo 1: Criar o Projeto e Ativar a API no Google Cloud (3 Minutos)

1. Acesse o console da Google Cloud:  
   👉 [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. No topo da tela, clique no seletor de projetos e clique em **"Novo Projeto"**:
   - Nome do projeto: `Warnat-Tech-Agenda`
   - Clique em **Criar**.
3. No menu lateral ou na barra de busca superior, pesquise por:  
   👉 **`Google Calendar API`**
4. Clique sobre ela e clique no botão azul **"Ativar"** (Enable).

---

## Passo 2: Criar a Conta de Serviço (Service Account) e Baixar a Chave

1. No menu lateral esquerdo, vá em **APIs e Serviços** > **Credenciais**.
2. Clique no botão superior **"+ Criar Credenciais"** > selecione **"Conta de serviço"** (Service Account).
   - Nome da conta de serviço: `warnat-bot-calendar`
   - Descrição: `Agendador automatico de visitas tecnicas`
   - Clique em **"Criar e Continuar"** > depois em **"Concluir"**.
3. Na lista de "Contas de serviço", clique em cima do e-mail que acabou de ser criado (algo como `warnat-bot-calendar@warnat-tech-agenda.iam.gserviceaccount.com`).
4. **COPIE esse e-mail da conta de serviço**, você vai precisar dele no Passo 3!
5. Clique na aba superior **"Chaves"** (Keys):
   - Clique em **"Adicionar Chave"** > **"Criar nova chave"**.
   - Escolha o tipo **JSON** e clique em **Criar**.
   - O arquivo será baixado no seu computador!

---

## Passo 3: Salvar a Chave no Projeto

1. Renomeie o arquivo baixado para:  
   👉 `google-credentials.json`
2. Mova esse arquivo para a pasta do seu projeto:  
   👉 `D:\Projetos\evolution\google-credentials.json`
3. No arquivo `D:\Projetos\evolution\.env`, adicione a linha:
   ```env
   GOOGLE_CALENDAR_ID=seu-email-pessoal@gmail.com
   ```
   *(Substitua pelo e-mail da conta Google onde você quer ver os agendamentos no seu celular)*.

---

## Passo 4: Dar Permissão na sua Agenda do Google (Importante!)

Como a Service Account é um "robô", você precisa dar permissão para ela escrever na sua agenda:

1. Abra o [Google Agenda](https://calendar.google.com/) no seu navegador com o seu e-mail.
2. Na barra lateral esquerda, em **"Minhas agendas"**, passe o mouse sobre o seu nome/agenda, clique nos **três pontinhos** e vá em **"Configurações e compartilhamento"**.
3. Role até a seção **"Compartilhar com pessoas ou grupos específicos"**:
   - Clique em **"Adicionar pessoas e grupos"**.
   - Cole o e-mail da Service Account (aquele que termina com `...gserviceaccount.com`).
   - Em **Permissões**, selecione: 👉 **"Fazer alterações nos eventos"**.
   - Clique em **Enviar**.

---

## Pronto! Como Testar:

Abra o terminal e execute:
```powershell
node d:\Projetos\evolution\calendar\test-calendar.js
```
O script testará a comunicação e mostrará os horários livres e ocupados de hoje direto da sua agenda!
