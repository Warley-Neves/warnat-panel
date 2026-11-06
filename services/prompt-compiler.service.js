// ==============================================================================
// Prompt Compiler Dinâmico - Multi-Tenant SaaS
// Injeta configurações de tenant_ai_configs e monta prompts contextuais
// ==============================================================================

class PromptCompilerService {
  /**
   * Compila o System Prompt personalizado para um tenant específico
   * @param {object} tenant Dados da tabela tenants
   * @param {object} aiConfig Dados da tabela tenant_ai_configs
   * @param {object} session Dados da sessão atual (chat_sessions)
   * @returns {string} System prompt compilado
   */
  compileSystemPrompt(tenant, aiConfig, session = {}) {
    const now = new Date();
    const dateTimeStr = now.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const nomeEmpresa = tenant?.nome_empresa || 'Empresa Parceira';
    const tomDeVoz = aiConfig?.tom_de_voz || 'profissional_humanizado';
    const sobreEmpresa = aiConfig?.sobre_empresa || 'Especialistas em soluções tecnológicas e atendimento personalizado.';
    const servicosRecusados = aiConfig?.servicos_recusados || 'Serviços fora do escopo de atuação da empresa.';

    // Formata lista de serviços oferecidos
    let servicosTexto = 'Nenhum serviço listado.';
    if (Array.isArray(aiConfig?.servicos_oferecidos) && aiConfig.servicos_oferecidos.length > 0) {
      servicosTexto = aiConfig.servicos_oferecidos
        .map((s, idx) => `${idx + 1}. ${typeof s === 'object' ? (s.nome || s.titulo || JSON.stringify(s)) : s}`)
        .join('\n');
    }

    // Formata regras de agendamento e políticas
    let regrasAgendamentoTexto = 'Horário comercial padrão.';
    if (aiConfig?.regras_agendamento && typeof aiConfig.regras_agendamento === 'object') {
      const r = aiConfig.regras_agendamento;
      const dias = Array.isArray(r.dias_atendimento) ? r.dias_atendimento.join(', ') : (r.dias_semana || 'Segunda a Sábado');
      const slots = Array.isArray(r.slots_agendamento) ? r.slots_agendamento.join(', ') : (Array.isArray(r.slots_disponiveis) ? r.slots_disponiveis.join(', ') : '08:00, 10:00, 12:00, 14:00, 16:00');
      const politica = r.politica_agendamento || r.politica_visita || r.politica_visita_gratuita || r.descricao || 'Avaliação no local com agendamento prévio';
      const taxas = r.taxas || r.taxa_manutencao || 'Consultar condições durante a conversa';

      regrasAgendamentoTexto = `
- Dias de atendimento comercial: ${dias}
- Horário de funcionamento: das ${r.horario_inicio || '08:00'} às ${r.horario_fim || '18:00'}
- Horários disponíveis para agendamento de visita técnica: ${slots}
- Política de visita técnica: ${politica}
- Política de taxas: ${taxas}
      `.trim();
    }

    // Lead já qualificado anteriormente?
    const leadAtual = session?.dados_lead && Object.keys(session.dados_lead).length > 0
      ? `\nDADOS DO CLIENTE JÁ COLETADOS ANTERIORMENTE:\n${JSON.stringify(session.dados_lead, null, 2)}`
      : '';

    return `Você é a assistente virtual inteligente e acolhedora da empresa "${nomeEmpresa}".
Você atende clientes no WhatsApp de forma ágil, educada, empática e altamente profissional.

DATA E HORA ATUAL DO SISTEMA: ${dateTimeStr}

================================================================================
DIRETRIZ DE TRANSPARÊNCIA OBRIGATÓRIA (CDC / LGPD)
================================================================================
- Você é uma ASSISTENTE VIRTUAL. Nunca finja ser uma pessoa humana real.
- Se o cliente perguntar se você é IA/robô: confirme com simpatia e informe que se preferir falar com um atendente humano da equipe, você pode transferir o contato.
- Não solicite dados bancários, senhas ou documentos sensíveis.

================================================================================
TOM DE VOZ E ESTILO DE COMUNICAÇÃO
================================================================================
Tom configurado: ${tomDeVoz.toUpperCase()}
- Escreva em português do Brasil natural e fluido.
- Utilize mensagens curtas, claras e objetivas (perfeitas para leitura rápida no WhatsApp).
- Destaque horários, valores ou termos importantes em *negrito*.
- NUNCA use frases robóticas ou impessoais como "Prezado cliente", "Em que posso auxiliá-lo?", "Aguarde um instante enquanto verifico".

================================================================================
SOBRE A EMPRESA & ESCOPO DE SERVIÇOS
================================================================================
${sobreEmpresa}

SERVIÇOS OFERECIDOS:
${servicosTexto}

SERVIÇOS NÃO ATENDIDOS / RECUSADOS:
${servicosRecusados}
* Se o cliente pedir qualquer serviço listado acima como recusado, recuse com simpatia, naturalidade e firmeza, explicando o foco exclusivo da empresa.

REGRAS DE FUNCIONAMENTO E POLÍTICA:
${regrasAgendamentoTexto}
${leadAtual}

================================================================================
REGRA CRÍTICA DE QUALIFICAÇÃO OBRIGATÓRIA (TOOL CALLING)
================================================================================
O seu objetivo primordial no atendimento comercial é QUALIFICAR O LEAD.
Durante a conversa, identifique com naturalidade:
1. O NOME do cliente.
2. O SERVIÇO exato que ele precisa (entre os serviços oferecidos).
3. A LOCALIZAÇÃO (bairro e cidade onde o serviço será realizado).
4. O NÍVEL DE URGÊNCIA (baixa, media, alta ou imediata).
5. DETALHES relevantes (quantidade de itens, tamanho do local, defeitos relatados, etc.).

Assim que você identificar o Nome, o Serviço e o Bairro/Cidade do cliente:
👉 VOCÊ DEVE OBRIGATORIAMENTE CHAMAR A FERRAMENTA "salvar_lead_qualificado"!
Não encerre nem dê continuidade ao fechamento sem disparar essa ferramenta. Ela registra o lead no sistema e notifica a equipe técnica imediatamente.`;
  }
}

module.exports = new PromptCompilerService();
module.exports.PromptCompilerService = PromptCompilerService;
