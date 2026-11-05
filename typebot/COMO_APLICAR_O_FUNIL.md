# GUIA PRÁTICO: COMO APLICAR O FUNIL OFICIAL NA SUA AUTOMAÇÃO
**WarNat Tech — Academia Comercial (Documentos 06, 09 e 10)**

---

## 🎯 OBJETIVO DA AUTOMAÇÃO
A automação foi calibrada para cumprir as duas regras de ouro do seu processo comercial:

1. **SE O CLIENTE FOR NOVO (PRÉ-VISITA):**
   * A prioridade absoluta é **CONDUZIR PARA A VISITA TÉCNICA**.
   * Regra 3.4 do Documento 06: *"Primeiro diagnosticar, depois recomendar"*.
   * Nunca passar preço cego sem ver o imóvel.
   * Novas instalações = **Visita 100% Gratuita**.
   * Manutenções = **R$ 140,00 de diagnóstico com 100% de crédito** se aprovar o conserto.

2. **SE A VISITA TÉCNICA JÁ OCORREU (PÓS-VISITA / CLIENTE COM PROPOSTA):**
   * A prioridade passa a ser **CONDUZIR PARA O FECHAMENTO E FORMALIZAÇÃO**.
   * Identificar dúvidas pendentes.
   * Tratar objeções pelo método **OUVIR** (Preço, Concorrente, Eletricista, Internet, etc.).
   * Validar qual opção ele prefere: **Essencial**, **Recomendada** (foco principal) ou **Completa**.
   * Acordar condições de pagamento (**Sinal para reserva dos equipamentos + Saldo na entrega**).
   * Travar a data de instalação na agenda técnica.

---

## 🛠️ MÉTODO 1: VIA INTELIGÊNCIA ARTIFICIAL NO TYPEBOT (RECOMENDADO)

Se você já utiliza o bloco **OpenAI** ou **Gemini** no seu fluxo do Typebot:

1. Acesse o editor do seu bot:
   👉 **[https://app.typebot.com/typebots/cmvr9s6wa000408jp2elhhw7i/edit](https://app.typebot.com/typebots/cmvr9s6wa000408jp2elhhw7i/edit)**
2. Clique no bloco **OpenAI (Create chat completion)**.
3. No campo **System Prompt** (Instruções do Sistema), substitua tudo pelo texto contido no arquivo:
   📄 `d:\Projetos\evolution\typebot\PROMPT_MESTRE_IA_FUNIL.md`
4. Configure os parâmetros recomendados:
   - **Modelo:** `gpt-4o-mini` (rápido, inteligente e de baixíssimo custo) ou Google Gemini.
   - **Temperature:** `0.4`
5. Clique no botão azul **Publish** no topo direito.

---

## 🌳 MÉTODO 2: ESTRUTURA VISUAL BLOCO A BLOCO (100% CONTROLADA)

Caso queira desenhar os blocos visuais diretamente no Typebot sem depender de respostas livres de IA:

### 1. Início e Roteamento de Estado (Novo vs Pós-Visita)
* **Bloco 1 (Text):**
  > *"Opa, tudo bem? Aqui é da equipe técnica da WarNat Tech!"*
* **Bloco 2 (Text Input -> `{{situacao_cliente}}`):**
  > *"Vi sua mensagem aqui. Para eu já te direcionar certinho: você é um novo cliente procurando instalação/manutenção, ou nós já fizemos uma visita técnica e você já está com a nossa proposta em mãos?"*

---

### RAMO A: SE FOR CLIENTE NOVO (CONDUZ PARA VISITA TÉCNICA)

* **Bloco A1 (Condition):** Se `{{situacao_cliente}}` não contiver "visita" nem "proposta":
* **Bloco A2 (Text Input -> `{{tipo_servico}}`):**
  > *"Perfeito! Você precisa de instalação de câmeras novas ou seria manutenção/conserto em um sistema que você já tem instalado?"*

#### Se Nova Instalação:
* **Bloco A3 (Text Input -> `{{bairro_imovel}}`):**
  > *"Show! O sistema de câmeras traz total tranquilidade para a família e para o negócio. Para instalação nova, nós realizamos uma visita técnica 100% GRATUITA e sem compromisso aí no seu local. O técnico avalia os pontos cegos e a iluminação para montar o projeto sob medida sem você gastar nada antes. Em qual bairro de BH ou região fica o imóvel?"*
* **Bloco A4 (Text Input -> `{{preferencia_data}}`):**
  > *"Ótimo, temos rotas frequentes nessa região! Qual dia e período fica melhor para o técnico passar aí: prefere no início ou no final da semana? Pela manhã ou à tarde?"*
* **Bloco A5 (Text Input -> `{{dados_finais}}`):**
  > *"Perfeito! Me passe por favor o seu nome completo e o endereço (com número e ponto de referência) para eu já reservar o horário na rota técnica."*
* **Bloco A6 (Text):**
  > *"Agendamento concluído com sucesso! Já registrei aqui. O Warley vai te chamar em instantes por este mesmo número só para confirmar o horário exato de chegada. Valeu!"*
* **Bloco A7 (Webhook de Alerta):**
  - Dispara alerta no WhatsApp pessoal de Warley com `{{tipo_servico}}`, `{{bairro_imovel}}`, `{{preferencia_data}}` e `{{dados_finais}}`.

#### Se Manutenção / Conserto:
* **Bloco A8 (Text Input -> `{{sintoma_defeito}}`):**
  > *"Certo! Manutenção exige cuidado técnico. Me conta resumidamente: o que está acontecendo com o sistema? (Ex: câmeras sem imagem, DVR apitando, sem acesso no celular, etc.)"*
* **Bloco A9 (Text Input -> `{{aceite_taxa}}`):**
  > *"Entendido. Para manutenção, nossa visita de diagnóstico tem uma taxa de R$ 140,00. Porém, se você aprovar o conserto com a gente, esse valor de R$ 140 é 100% ABATIDO do total do serviço (você só paga a diferença das peças e mão de obra). Podemos agendar para o técnico avaliar seu sistema?"*
* Conecta para o Bloco A4 (data e endereço).

---

### RAMO B: SE JÁ FEZ A VISITA TÉCNICA (CONDUZ PARA FECHAMENTO)

* **Bloco B1 (Condition):** Se `{{situacao_cliente}}` contiver "visita", "proposta", "orçamento" ou "já veio":
* **Bloco B2 (Text Input -> `{{opcao_proposta}}`):**
  > *"Excelente! O Warley me passou o resumo da visita aí no seu imóvel. Você conseguiu avaliar a proposta? Nós montamos as opções pensando exatamente no que você precisa. Você ficou com alguma dúvida técnica sobre os pontos de cobertura, ou já podemos formalizar a opção recomendada?"*

#### Tratamento de Respostas:
1. **Se o cliente aprovar / escolher opção:**
   * **Bloco B3 (Text):**
     > *"Show de bola! Excelente escolha. Para formalizarmos a contratação e garantirmos a data na agenda, nós trabalhamos com um sinal para compra e reserva dos seus equipamentos lacrados, e o saldo restante fica apenas para a entrega com tudo testado e funcionando no seu celular."*
   * **Bloco B4 (Text Input -> `{{data_instalacao}}`):**
     > *"Qual dia da semana você prefere para iniciarmos a instalação no seu imóvel?"*
   * **Bloco B5 (Webhook - Fechado Ganho):**
     > Dispara alerta para Warley: `🎉 VENDA PRONTA PARA FORMALIZAR - CLIENTE: {{nome}} - OPÇÃO: {{opcao_proposta}}`.

2. **Se o cliente apresentar objeções ("está caro", "vou pensar", "outra empresa cobrou menos"):**
   * O bloco de IA (Método 1) responde aplicando o **Método OUVIR**:
     - *Investiga se compara com concorrência ou internet.*
     - *Explica a diferença entre cabo 100% cobre homologado vs alumínio que oxida.*
     - *Explica HD de vigilância 24/7 vs HD de computador usado que queima.*
     - *Oferece divisão por etapas sem perder a margem.*

---

## 📱 COMO FICA O MONITORAMENTO NO CHATWOOT (`http://localhost:3000`)
- Toda vez que o bot conversa com o cliente, a conversa atualiza em tempo real na tela do Chatwoot.
- Se o cliente disser *"já fiz a visita técnica"*, o atendente humano no Chatwoot vê a etiqueta e pode intervir a qualquer segundo digitando diretamente na caixa de mensagem.
- O robô silencia automaticamente no momento em que você responder manualmente (`stopBotFromMe: true`).
