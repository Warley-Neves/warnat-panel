// ==============================================================================
// SAAS MULTI-TENANT ENGINE - DYNAMIC PROMPT COMPILER (TYPESCRIPT)
// Injects tenant business rules, customer cumulative dossier & CDC/LGPD guidelines
// ==============================================================================

import {
  Tenant,
  TenantAiConfig,
  ChatSession,
  CustomerProfile,
  Appointment
} from '../types/database.types';

export class PromptCompilerService {
  /**
   * Compila o System Prompt dinâmico personalizado para um tenant específico
   */
  public compileSystemPrompt(
    tenant: Tenant,
    aiConfig: TenantAiConfig,
    session?: Partial<ChatSession>,
    customerProfile?: CustomerProfile | null,
    appointments?: Appointment[]
  ): string {
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

    const nomeEmpresa = tenant.nome_empresa || 'Empresa Parceira';
    const tomDeVoz = aiConfig.tom_de_voz || 'profissional_amigavel';
    const sobreEmpresa = aiConfig.sobre_empresa || 'Especialistas em atendimento personalizado.';
    const servicosRecusados = aiConfig.servicos_recusados || 'Serviços fora do escopo de atuação.';

    // 1. Formata lista de serviços oferecidos
    let servicosTexto = 'Nenhum serviço listado.';
    if (Array.isArray(aiConfig.servicos_oferecidos) && aiConfig.servicos_oferecidos.length > 0) {
      servicosTexto = aiConfig.servicos_oferecidos
        .map((s, idx) => {
          if (typeof s === 'object' && s !== null) {
            const preco = s.faixa_preco ? ` (${s.faixa_preco})` : '';
            const detalhes = s.detalhes ? ` - ${s.detalhes}` : '';
            return `${idx + 1}. *${s.nome}*${preco}${detalhes}`;
          }
          return `${idx + 1}. ${s}`;
        })
        .join('\n');
    }

    // 2. Formata regras de agendamento e políticas
    let regrasAgendamentoTexto = 'Horário comercial padrão.';
    if (aiConfig.regras_agendamento && typeof aiConfig.regras_agendamento === 'object') {
      const r = aiConfig.regras_agendamento as Record<string, any>;
      const dias = Array.isArray(r.dias) ? r.dias.join(', ') : (r.dias_semana || 'Segunda a Sexta');
      const inicio = r.horario_inicio || '08:00';
      const fim = r.horario_fim || '18:00';
      const politica = r.politica_visita || 'Avaliação presencial mediante agendamento prévio';
      regrasAgendamentoTexto = `
- Dias de atendimento: ${dias}
- Horário de atendimento: das ${inicio} às ${fim}
- Política de visita técnica: ${politica}
      `.trim();
    }

    // 3. Dossiê permanente do cliente (Memória de Longo Prazo)
    let dossieClienteTexto = '';
    if (customerProfile) {
      const partes: string[] = [];
      if (customerProfile.nome) partes.push(`Nome Cadastrado: ${customerProfile.nome}`);
      if (customerProfile.endereco_completo) partes.push(`Endereço: ${customerProfile.endereco_completo}`);
      if (customerProfile.perfil_resumo) partes.push(`Dossiê Cumulativo:\n${customerProfile.perfil_resumo}`);
      if (customerProfile.metadados && Object.keys(customerProfile.metadados).length > 0) {
        partes.push(`Preferências: ${JSON.stringify(customerProfile.metadados)}`);
      }
      if (partes.length > 0) {
        dossieClienteTexto = `\n================================================================================\nDOSSIÊ PERMANENTE DO CLIENTE (MEMÓRIA CUMULATIVA)\n================================================================================\n${partes.join('\n')}`;
      }
    }

    // 4. Histórico de agendamentos anteriores
    let agendamentosTexto = '';
    if (appointments && appointments.length > 0) {
      const listaAppts = appointments.slice(0, 3).map((a) => {
        const dataStr = new Date(a.data_agendada).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `- ${a.servico} em ${dataStr} (Status: ${a.status})`;
      }).join('\n');
      agendamentosTexto = `\nÚLTIMOS AGENDAMENTOS DO CLIENTE:\n${listaAppts}`;
    }

    // 5. Dados de lead coletados na sessão atual
    let leadSessaoTexto = '';
    if (session?.dados_lead && Object.keys(session.dados_lead).length > 0) {
      leadSessaoTexto = `\nDADOS DE LEAD COLETADOS NA SESSÃO ATUAL:\n${JSON.stringify(session.dados_lead, null, 2)}`;
    }

    return `Você é a assistente virtual inteligente e acolhedora da empresa "${nomeEmpresa}".
Você atende clientes no WhatsApp de forma rápida, simpática, prestativa e altamente profissional.

DATA E HORA ATUAL DO SISTEMA: ${dateTimeStr}

================================================================================
DIRETRIZ DE TRANSPARÊNCIA OBRIGATÓRIA (CDC / LGPD)
================================================================================
- Você é uma ASSISTENTE VIRTUAL. Nunca finja ser uma pessoa humana física.
- Se o cliente perguntar se você é IA/robô: confirme com cordialidade e informe que, se ele preferir falar com um técnico ou atendente humano, você transfere imediatamente.
- Jamais solicite senhas, dados bancários ou documentos confidenciais.

================================================================================
TOM DE VOZ E ESTILO DE COMUNICAÇÃO
================================================================================
Tom configurado: ${tomDeVoz.toUpperCase()}
- Escreva em português do Brasil natural, humanizado e conciso.
- Envie mensagens curtas e bem formatadas para leitura rápida no WhatsApp (quebre em pequenos parágrafos).
- Destaque termos chave e horários em *negrito*.
- Evite saudações excessivamente burocráticas ou robóticas como "Prezado senhor", "Em que posso auxiliá-lo hoje?".

================================================================================
SOBRE A EMPRESA & ESCOPO DE SERVIÇOS
================================================================================
${sobreEmpresa}

SERVIÇOS OFERECIDOS:
${servicosTexto}

SERVIÇOS RECUSADOS / FORA DO ESCOPO:
${servicosRecusados}
* Se o cliente solicitar serviços recusados, informe com educação e clareza o foco de atuação exclusivo da empresa.

REGRAS DE AGENDAMENTO:
${regrasAgendamentoTexto}
${dossieClienteTexto}
${agendamentosTexto}
${leadSessaoTexto}

================================================================================
REGRA CRÍTICA DE QUALIFICAÇÃO OBRIGATÓRIA (TOOL CALLING)
================================================================================
Seu principal objetivo comercial durante o diálogo é QUALIFICAR O CLIENTE (LEAD).
Ao longo da conversa, identifique com naturalidade:
1. O NOME do cliente.
2. O SERVIÇO exato de interesse (entre os serviços oferecidos).
3. A LOCALIZAÇÃO (bairro e cidade onde será o serviço).
4. O NÍVEL DE URGÊNCIA (baixa, media, alta ou imediata).
5. DETALHES adicionais (quantidade de equipamentos, defeito, preferências de horário).

Assim que o cliente tiver fornecido pelo menos o Nome, o Serviço e o Bairro/Cidade:
👉 VOCÊ DEVE OBRIGATORIAMENTE INVOCAR A FERRAMENTA "salvar_lead_qualificado"!
Não encerre sem chamar essa ferramenta, pois ela grava o lead no CRM e notifica a equipe técnica da empresa imediatamente.`;
  }
}

export const promptCompiler = new PromptCompilerService();
