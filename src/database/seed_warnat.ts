// ==============================================================================
// SAAS MULTI-TENANT ENGINE - SEED TENANT #1 (WARNAT TECH) [TYPESCRIPT]
// Provisiona a WarNat Tech, usuário admin, instância WhatsApp e regras reais de IA
// ==============================================================================

import { query, withTransaction, shutdownPool } from './db';
import { AuthService } from '../services/auth.service';
import { CustomerService } from '../services/customer.service';

export interface SeedResult {
  success: boolean;
  tenantId: string;
  adminEmail: string;
  instanceName: string;
  customerProfileId: string;
}

export async function seedWarNatTech(): Promise<SeedResult> {
  console.log('------------------------------------------------------------');
  console.log('🌱 [Seed] Provisionando Tenant #1: WarNat Tech...');
  console.log('------------------------------------------------------------');

  return await withTransaction<SeedResult>(async (client) => {
    // 1. Cadastra ou recupera o Tenant WarNat Tech
    const tenantRes = await client.query(
      `SELECT id, nome_empresa FROM tenants WHERE nome_empresa = 'WarNat Tech' LIMIT 1;`
    );

    let tenantId: string;
    if (tenantRes.rows.length === 0) {
      const newTenant = await client.query(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo)
         VALUES ('WarNat Tech', '45.123.789/0001-10', 'enterprise', 5000, true)
         RETURNING id, nome_empresa;`
      );
      tenantId = newTenant.rows[0].id;
      console.log(`✅ [Seed] Tenant #1 criado: WarNat Tech (ID: ${tenantId})`);
    } else {
      tenantId = tenantRes.rows[0].id;
      console.log(`ℹ️ [Seed] Tenant #1 WarNat Tech já existe (ID: ${tenantId})`);
    }

    // 2. Cadastra Usuário Administrador (Warley Santos)
    const adminEmail = 'admin@warnattech.com.br';
    const userRes = await client.query(`SELECT id FROM users WHERE email = $1;`, [adminEmail]);

    if (userRes.rows.length === 0) {
      const passwordHash = await AuthService.hashPassword('WarnatAdmin2026!');
      const newUser = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, nome)
         VALUES ($1, $2, $3, 'admin', 'Warley Santos')
         RETURNING id, email, role, nome;`,
        [tenantId, adminEmail, passwordHash]
      );
      console.log(`✅ [Seed] Administrador cadastrado: ${newUser.rows[0].nome} (${newUser.rows[0].email})`);
    } else {
      console.log(`ℹ️ [Seed] Administrador (${adminEmail}) já cadastrado.`);
    }

    // 3. Cadastra e vincula Instância da Evolution API
    const instanceName = 'warnat-tech';
    await client.query(
      `INSERT INTO tenant_whatsapp_instances (
         tenant_id, instance_name, instance_token, numero_telefone, status, webhook_url
       ) VALUES ($1, $2, 'token-interno-warnat-123', '5531983525816', 'open', 'https://api.warnattech.com.br/api/webhook/whatsapp')
       ON CONFLICT (instance_name)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         numero_telefone = EXCLUDED.numero_telefone,
         status = 'open',
         updated_at = NOW();`,
      [tenantId, instanceName]
    );
    console.log(`✅ [Seed] Instância WhatsApp "${instanceName}" vinculada ao tenant WarNat Tech com número (31) 98352-5816.`);

    // 4. Cadastra Configurações de IA Comerciais da WarNat Tech
    const servicosOferecidos = [
      {
        nome: 'Nova Instalação de Câmeras de Segurança (CFTV HD / IP / Wi-Fi)',
        faixa_preco: 'A partir de R$ 350,00',
        detalhes: 'Câmeras Intelbras Full HD e 4K com gravação contínua e visualização remota no celular.'
      },
      {
        nome: 'Manutenção e Reparo de CFTV',
        faixa_preco: 'Taxa de visita técnica R$ 140,00',
        detalhes: 'Troca de conectores BNC/P4, substituição de fontes colmeia, reposicionamento e ajuste de foco. Valor 100% abatível no conserto.'
      },
      {
        nome: 'Configuração de Acesso Remoto no Celular',
        faixa_preco: 'R$ 150,00',
        detalhes: 'Configuração de DDNS, nuvem P2P Intelbras Cloud / Hik-Connect e liberação de portas no roteador.'
      },
      {
        nome: 'Instalação de Alarmes e Sensores de Intrusão',
        faixa_preco: 'Sob orçamento no local',
        detalhes: 'Sistemas cabeados e sem fio com sirene de alta potência e disparo no smartphone.'
      }
    ];

    const regrasAgendamento = {
      dias: ['sabado'],
      horario_inicio: '08:00',
      horario_fim: '18:00',
      slots_disponiveis: ['08:00', '10:00', '12:00', '14:00', '16:00'],
      politica_visita_gratuita: 'A visita técnica de diagnóstico é 100% gratuita exclusivamente para novas instalações de sistemas de câmeras.',
      taxa_manutencao: 'Para manutenção em sistemas já existentes, a taxa de visita técnica é de R$ 140,00, valor integralmente abatido caso o cliente aprove o serviço.'
    };

    await client.query(
      `INSERT INTO tenant_ai_configs (
         tenant_id,
         tom_de_voz,
         sobre_empresa,
         servicos_oferecidos,
         servicos_recusados,
         regras_agendamento,
         whatsapp_notificacao_humana,
         pausa_automatica_minutos,
         updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         tom_de_voz = EXCLUDED.tom_de_voz,
         sobre_empresa = EXCLUDED.sobre_empresa,
         servicos_oferecidos = EXCLUDED.servicos_oferecidos,
         servicos_recusados = EXCLUDED.servicos_recusados,
         regras_agendamento = EXCLUDED.regras_agendamento,
         whatsapp_notificacao_humana = EXCLUDED.whatsapp_notificacao_humana,
         pausa_automatica_minutos = EXCLUDED.pausa_automatica_minutos,
         updated_at = NOW();`,
      [
        tenantId,
        'profissional_amigavel',
        'A WarNat Tech é uma empresa especializada em Sistemas de Câmeras de Segurança e CFTV (Residencial, Comercial e Condominial) em Belo Horizonte, Barreiro e Grande BH, liderada pelo especialista técnico Warley Santos.',
        JSON.stringify(servicosOferecidos),
        'Não atendemos pintura, alarmes veiculares, decorações, buffet, pedreiro ou conserto de eletrodomésticos. Nosso foco é 100% exclusivo em câmeras de segurança e CFTV.',
        JSON.stringify(regrasAgendamento),
        '5531983525816',
        45
      ]
    );
    console.log(`✅ [Seed] Regras da IA e políticas comerciais da WarNat Tech configuradas no banco com notificação em 5531983525816.`);

    // 5. Cadastra Dossiê Permanente de Homologação em customer_profiles
    const homologJid = '5531983525816@s.whatsapp.net';
    const profile = await CustomerService.findOrCreateProfile(tenantId, homologJid, {
      nome: 'Warley Santos (Administrador)',
      telefone: '5531983525816',
      endereco_completo: 'Bairro Barreiro - Belo Horizonte / MG',
      perfil_resumo: 'Cliente VIP e Administrador do Sistema. Responsável Técnico pela WarNat Tech.',
      metadados: { cliente_vip: true, canal: 'whatsapp_oficial' }
    });
    console.log(`✅ [Seed] Dossiê permanente do cliente homologado (ID: ${profile.id}).`);

    // 6. Cadastra Agendamento Exemplo em appointments
    const proximoSabado = new Date();
    proximoSabado.setDate(proximoSabado.getDate() + ((6 - proximoSabado.getDay() + 7) % 7 || 7));
    proximoSabado.setHours(10, 0, 0, 0);

    await client.query(
      `INSERT INTO appointments (
         tenant_id, customer_id, remote_jid, servico, data_agendada, status, valor_estimado, observacoes
       ) VALUES ($1, $2, $3, $4, $5, 'agendado', 350.00, 'Visita técnica de homologação WarNat Tech.')
       ON CONFLICT DO NOTHING;`,
      [tenantId, profile.id, homologJid, 'Instalação de Câmeras CFTV', proximoSabado]
    );
    console.log(`✅ [Seed] Histórico de agendamento registrado para o próximo sábado.`);

    console.log('------------------------------------------------------------');
    console.log('🎉 [Seed] WarNat Tech provisionada com 100% de sucesso!');
    console.log('------------------------------------------------------------\n');

    return {
      success: true,
      tenantId,
      adminEmail,
      instanceName,
      customerProfileId: profile.id
    };
  });
}

if (require.main === module) {
  seedWarNatTech()
    .then(() => {
      setTimeout(() => shutdownPool().then(() => process.exit(0)), 100);
    })
    .catch((err) => {
      console.error(err);
      setTimeout(() => shutdownPool().then(() => process.exit(1)), 100);
    });
}
