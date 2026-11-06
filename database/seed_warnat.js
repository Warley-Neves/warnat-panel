// ==============================================================================
// Seed Script: Tenant #1 - WarNat Tech
// Cadastra a empresa WarNat Tech, usuário admin, instância e regras de IA
// ==============================================================================

const { query, pool } = require('./db');
const authService = require('./auth.service');

async function seedWarNatTech() {
  console.log('------------------------------------------------------------');
  console.log('🌱 Executando Seed do Tenant #1: WarNat Tech...');
  console.log('------------------------------------------------------------');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Cadastrar / Obter Tenant WarNat Tech
    let tenantRes = await client.query(
      `SELECT id, nome_empresa FROM tenants WHERE nome_empresa = 'WarNat Tech' LIMIT 1`
    );

    let tenantId;
    if (tenantRes.rowCount === 0) {
      const newTenant = await client.query(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo)
         VALUES ('WarNat Tech', '45.123.789/0001-10', 'enterprise', 5000, true)
         RETURNING id, nome_empresa`
      );
      tenantId = newTenant.rows[0].id;
      console.log(`✅ Tenant criado: WarNat Tech (ID: ${tenantId})`);
    } else {
      tenantId = tenantRes.rows[0].id;
      console.log(`ℹ️ Tenant WarNat Tech já existe (ID: ${tenantId})`);
    }

    // 2. Cadastrar Usuário Administrador (Warley Santos)
    const adminEmail = 'admin@warnattech.com.br';
    const existingUser = await client.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);

    if (existingUser.rowCount === 0) {
      const passwordHash = await authService.hashPassword('WarnatAdmin2026!');
      const newUser = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, nome)
         VALUES ($1, $2, $3, 'admin', 'Warley Santos')
         RETURNING id, email, role, nome`,
        [tenantId, adminEmail, passwordHash]
      );
      console.log(`✅ Usuário Admin criado: ${newUser.rows[0].nome} (${newUser.rows[0].email})`);
    } else {
      console.log(`ℹ️ Usuário Admin (${adminEmail}) já cadastrado.`);
    }

    // 3. Cadastrar / Vincular Instância do WhatsApp da Evolution API
    const instanceName = 'warnat-tech';
    await client.query(
      `INSERT INTO tenant_whatsapp_instances (
         tenant_id, instance_name, instance_token, numero_telefone, status, webhook_url
       ) VALUES ($1, $2, 'token-interno-warnat-123', '5531983579692', 'open', 'https://api.warnattech.com.br/api/webhook/whatsapp')
       ON CONFLICT (instance_name)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         status = 'open',
         updated_at = now()`,
      [tenantId, instanceName]
    );
    console.log(`✅ Instância WhatsApp "${instanceName}" vinculada ao tenant WarNat Tech.`);

    // 4. Cadastrar Regras da IA e Prompt Compiler Dinâmico
    const servicosOferecidos = [
      'Nova instalação de sistemas de câmeras de segurança e CFTV HD / IP / Wi-Fi',
      'Manutenção, reparo, troca de fontes, câmeras queimadas e reconfiguração de DVR/NVR',
      'Configuração de visualização remota das câmeras pelo celular'
    ];

    const regrasAgendamento = {
      dias_semana: 'Segunda a Sábado',
      horario_inicio: '08:00',
      horario_fim: '20:00',
      politica_visita_gratuita: 'A visita técnica de diagnóstico é 100% gratuita exclusivamente para NOVAS INSTALAÇÕES de câmeras.',
      taxa_manutencao: 'Para manutenção em câmeras existentes, a taxa de visita técnica é de R$ 140,00, valor que é 100% aproveitado e abatido no conserto.'
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
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         tom_de_voz = EXCLUDED.tom_de_voz,
         sobre_empresa = EXCLUDED.sobre_empresa,
         servicos_oferecidos = EXCLUDED.servicos_oferecidos,
         servicos_recusados = EXCLUDED.servicos_recusados,
         regras_agendamento = EXCLUDED.regras_agendamento,
         whatsapp_notificacao_humana = EXCLUDED.whatsapp_notificacao_humana,
         pausa_automatica_minutos = EXCLUDED.pausa_automatica_minutos,
         updated_at = now()`,
      [
        tenantId,
        'profissional_humanizado',
        'Especialistas em Sistemas de Câmeras de Segurança e CFTV (Residencial, Comercial e Condominial) em Belo Horizonte, Barreiro e Grande BH, liderados pelo especialista técnico Warley Santos.',
        JSON.stringify(servicosOferecidos),
        'Não atendemos pintura, alarmes veiculares, decorações, buffet, pedreiro ou conserto de eletrodomésticos. Nosso foco é 100% exclusivo em câmeras de segurança e CFTV.',
        JSON.stringify(regrasAgendamento),
        '5531983579692',
        45
      ]
    );
    console.log(`✅ Regras da IA e políticas comerciais da WarNat Tech configuradas no banco.`);

    await client.query('COMMIT');
    console.log('------------------------------------------------------------');
    console.log('🎉 Seed da WarNat Tech concluído com sucesso!');
    console.log('------------------------------------------------------------');
    return { success: true, tenantId };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro no seed da WarNat Tech:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seedWarNatTech()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { seedWarNatTech };
