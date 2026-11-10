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

    // 1. Cadastrar / Obter Tenant Master do Dono do SaaS
    let masterTenantRes = await client.query(
      `SELECT id, nome_empresa FROM tenants WHERE nome_empresa = 'WarNat SaaS (Gestão Master)' LIMIT 1`
    );

    let masterTenantId;
    if (masterTenantRes.rowCount === 0) {
      const newMaster = await client.query(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo, status)
         VALUES ('WarNat SaaS (Gestão Master)', '00.000.000/0001-00', 'enterprise', 999999, true, 'ACTIVE')
         RETURNING id, nome_empresa`
      );
      masterTenantId = newMaster.rows[0].id;
      console.log(`✅ Tenant Master do SaaS criado (ID: ${masterTenantId})`);
    } else {
      masterTenantId = masterTenantRes.rows[0].id;
      console.log(`ℹ️ Tenant Master do SaaS já existe (ID: ${masterTenantId})`);
    }

    // 2. Usuário Dono do SaaS (admin@warnattech.com.br) - Exclusivo para Gestão do SaaS
    const saEmail = 'admin@warnattech.com.br';
    const saCheck = await client.query(`SELECT id FROM users WHERE email = $1`, [saEmail]);
    const saHash = await authService.hashPassword('WarnatAdmin2026!');

    if (saCheck.rowCount === 0) {
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, nome, is_super_admin, telefone)
         VALUES ($1, $2, $3, 'admin', 'Warley Santos (Dono)', true, '5531983525816')`,
        [masterTenantId, saEmail, saHash]
      );
      console.log(`✅ Usuário Dono do SaaS criado: ${saEmail}`);
    } else {
      await client.query(
        `UPDATE users SET tenant_id = $1, is_super_admin = true, role = 'admin', nome = 'Warley Santos (Dono)', telefone = COALESCE(telefone, '5531983525816') WHERE email = $2`,
        [masterTenantId, saEmail]
      );
      console.log(`ℹ️ Usuário Dono do SaaS (${saEmail}) vinculado exclusivamente ao Tenant Master.`);
    }

    // 3. Cadastrar / Obter Tenant Cliente WarNat Tech
    let tenantRes = await client.query(
      `SELECT id, nome_empresa FROM tenants WHERE nome_empresa = 'WarNat Tech' LIMIT 1`
    );

    let tenantId;
    if (tenantRes.rowCount === 0) {
      const newTenant = await client.query(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo, status)
         VALUES ('WarNat Tech', '45.123.789/0001-10', 'enterprise', 5000, true, 'ACTIVE')
         RETURNING id, nome_empresa`
      );
      tenantId = newTenant.rows[0].id;
      console.log(`✅ Tenant Cliente criado: WarNat Tech (ID: ${tenantId})`);
    } else {
      tenantId = tenantRes.rows[0].id;
      console.log(`ℹ️ Tenant Cliente WarNat Tech já existe (ID: ${tenantId})`);
    }

    // 4. Cadastrar / Atualizar Usuário Operacional da WarNat Tech (warley.santos@warnattech.com.br)
    const clientEmail = 'warley.santos@warnattech.com.br';
    const clientCheck = await client.query(`SELECT id FROM users WHERE email = $1`, [clientEmail]);
    const clientHash = await authService.hashPassword('WarnatAdmin2026!');

    if (clientCheck.rowCount === 0) {
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, nome, is_super_admin, telefone)
         VALUES ($1, $2, $3, 'admin', 'Warley Santos', false, '5531983525816')`,
        [tenantId, clientEmail, clientHash]
      );
      console.log(`✅ Usuário da WarNat Tech criado: ${clientEmail} (vinculado ao tenant WarNat Tech)`);
    } else {
      await client.query(
        `UPDATE users SET tenant_id = $1, role = 'admin', is_super_admin = false, telefone = COALESCE(telefone, '5531983525816') WHERE email = $2`,
        [tenantId, clientEmail]
      );
      console.log(`ℹ️ Usuário da WarNat Tech (${clientEmail}) sincronizado com o tenant WarNat Tech.`);
    }

    // 5. Cadastrar / Vincular Instância do WhatsApp da Evolution API
    const existingInstance = await client.query(
      `SELECT id, instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    if (existingInstance.rowCount > 0) {
      await client.query(
        `UPDATE tenant_whatsapp_instances
         SET status = 'open',
             numero_telefone = COALESCE(numero_telefone, '5531983525816'),
             webhook_url = COALESCE(webhook_url, 'https://warnat-panel.onrender.com/api/webhook/whatsapp'),
             updated_at = now()
         WHERE tenant_id = $1`,
        [tenantId]
      );
      console.log(`ℹ️ Instância WhatsApp existente mantida para tenant ${tenantId} (${existingInstance.rows[0].instance_name})`);
    } else {
      const instanceName = 'warnat-tech';
      await client.query(
        `INSERT INTO tenant_whatsapp_instances (
           tenant_id, instance_name, instance_token, numero_telefone, status, webhook_url
         ) VALUES ($1, $2, 'token-interno-warnat-123', '5531983525816', 'open', 'https://warnat-panel.onrender.com/api/webhook/whatsapp')
         ON CONFLICT (instance_name)
         DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           numero_telefone = EXCLUDED.numero_telefone,
           status = 'open',
           updated_at = now()`,
        [tenantId, instanceName]
      );
      console.log(`✅ Instância WhatsApp "${instanceName}" vinculada ao tenant WarNat Tech com número (31) 98352-5816.`);
    }

    // 4. Cadastrar Regras da IA e Prompt Compiler Dinâmico
    const servicosOferecidos = [
      'Nova instalação de sistemas de câmeras de segurança e CFTV HD / IP / Wi-Fi',
      'Manutenção, reparo, troca de fontes, câmeras queimadas e reconfiguração de DVR/NVR',
      'Configuração de visualização remota das câmeras pelo celular'
    ];

    const regrasAgendamento = {
      dias_semana: 'Segunda a Sábado',
      dias_atendimento: ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'],
      horario_inicio: '08:00',
      horario_fim: '20:00',
      slots_agendamento: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'],
      politica_visita_gratuita: 'A visita técnica de diagnóstico e avaliação de pontos cegos é 100% gratuita e sem compromisso exclusivamente para NOVAS INSTALAÇÕES de câmeras.',
      taxa_manutencao: 'Para manutenção ou reparo em câmeras existentes, a taxa de visita técnica é de R$ 140,00, valor integralmente aproveitado e abatido no conserto.'
    };

    await client.query(
      `INSERT INTO tenant_ai_configs (
         tenant_id,
         modo_atendimento,
         nome_assistente,
         responsavel_tecnico,
         regiao_atendimento,
         taxa_manutencao_reais,
         tom_de_voz,
         sobre_empresa,
         servicos_oferecidos,
         servicos_recusados,
         regras_agendamento,
         whatsapp_notificacao_humana,
         pausa_automatica_minutos,
         atender_chamadas,
         responder_com_audio,
         voz_ia,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         modo_atendimento = COALESCE(tenant_ai_configs.modo_atendimento, EXCLUDED.modo_atendimento),
         nome_assistente = EXCLUDED.nome_assistente,
         responsavel_tecnico = EXCLUDED.responsavel_tecnico,
         regiao_atendimento = EXCLUDED.regiao_atendimento,
         taxa_manutencao_reais = EXCLUDED.taxa_manutencao_reais,
         tom_de_voz = EXCLUDED.tom_de_voz,
         sobre_empresa = EXCLUDED.sobre_empresa,
         servicos_oferecidos = EXCLUDED.servicos_oferecidos,
         servicos_recusados = EXCLUDED.servicos_recusados,
         regras_agendamento = EXCLUDED.regras_agendamento,
         whatsapp_notificacao_humana = EXCLUDED.whatsapp_notificacao_humana,
         pausa_automatica_minutos = EXCLUDED.pausa_automatica_minutos,
         atender_chamadas = COALESCE(tenant_ai_configs.atender_chamadas, EXCLUDED.atender_chamadas),
         responder_com_audio = COALESCE(tenant_ai_configs.responder_com_audio, EXCLUDED.responder_com_audio),
         voz_ia = COALESCE(tenant_ai_configs.voz_ia, EXCLUDED.voz_ia),
         updated_at = now()`,
      [
        tenantId,
        'automacao',
        'Nat',
        'Warley Santos',
        'Belo Horizonte, Barreiro e Grande BH',
        140.00,
        'profissional_humanizado',
        'Especialistas em Sistemas de Câmeras de Segurança e CFTV (Residencial, Comercial e Condominial) em Belo Horizonte, Barreiro e Grande BH, liderados pelo especialista técnico Warley Santos.',
        JSON.stringify(servicosOferecidos),
        'Não atendemos pintura, alarmes veiculares, decorações, buffet, pedreiro ou conserto de eletrodomésticos. Nosso foco é 100% exclusivo em câmeras de segurança e CFTV.',
        JSON.stringify(regrasAgendamento),
        '5531983525816',
        45,
        true,
        'texto',
        'nova'
      ]
    );
    console.log(`✅ Regras da IA e políticas comerciais da WarNat Tech configuradas no banco com notificação em 5531983525816.`);

    // 5. Cadastrar Dossiê Permanente em customer_profiles
    const homologJid = '5531983525816@s.whatsapp.net';
    await client.query(
      `INSERT INTO customer_profiles (
         tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, remote_jid)
       DO UPDATE SET
         nome = EXCLUDED.nome,
         telefone = EXCLUDED.telefone,
         updated_at = now()`,
      [
        tenantId,
        homologJid,
        'Warley Santos (Administrador)',
        '5531983525816',
        'Belo Horizonte / MG',
        'Administrador e Proprietário da WarNat Tech.',
        JSON.stringify({ admin: true, canal: 'whatsapp_oficial' })
      ]
    );
    console.log(`✅ Dossiê permanente do administrador Warley Santos provisionado.`);

    // ==============================================================================
    // 6. Cadastrar / Obter Tenant Cliente: WN Velas artesanais
    // ==============================================================================
    let velasRes = await client.query(
      `SELECT id, nome_empresa FROM tenants WHERE nome_empresa ILIKE '%velas%' LIMIT 1`
    );

    let velasTenantId;
    if (velasRes.rowCount === 0) {
      const newVelas = await client.query(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo, status)
         VALUES ('WN Velas artesanais', '12.345.678/0001-90', 'pro', 5000, true, 'ACTIVE')
         RETURNING id, nome_empresa`
      );
      velasTenantId = newVelas.rows[0].id;
      console.log(`✅ Tenant Cliente criado: WN Velas artesanais (ID: ${velasTenantId})`);
    } else {
      velasTenantId = velasRes.rows[0].id;
      console.log(`ℹ️ Tenant Cliente WN Velas artesanais já existe (ID: ${velasTenantId})`);
    }

    // 7. Cadastrar / Sincronizar Usuário da WN Velas artesanais (warley.santosst@gmail.com)
    const velasEmail = 'warley.santosst@gmail.com';
    const velasUserCheck = await client.query(`SELECT id FROM users WHERE email = $1`, [velasEmail]);
    const velasHash = await authService.hashPassword('WarnatAdmin2026!');

    if (velasUserCheck.rowCount === 0) {
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, nome, is_super_admin, telefone)
         VALUES ($1, $2, $3, 'admin', 'Warley Santos (Velas)', false, '5531983525816')`,
        [velasTenantId, velasEmail, velasHash]
      );
      console.log(`✅ Usuário da WN Velas artesanais criado: ${velasEmail}`);
    } else {
      await client.query(
        `UPDATE users SET tenant_id = $1, role = 'admin', is_super_admin = false, telefone = COALESCE(telefone, '5531983525816') WHERE email = $2`,
        [velasTenantId, velasEmail]
      );
      console.log(`ℹ️ Usuário da WN Velas artesanais (${velasEmail}) sincronizado.`);
    }

    // 8. Vincular Instância WhatsApp wn-velas
    const existingVelasInst = await client.query(
      `SELECT id, instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
      [velasTenantId]
    );
    if (existingVelasInst.rowCount > 0) {
      await client.query(
        `UPDATE tenant_whatsapp_instances
         SET status = 'open',
             updated_at = now()
         WHERE tenant_id = $1`,
        [velasTenantId]
      );
      console.log(`ℹ️ Instância WhatsApp existente mantida para WN Velas (${existingVelasInst.rows[0].instance_name})`);
    } else {
      await client.query(
        `INSERT INTO tenant_whatsapp_instances (
           tenant_id, instance_name, instance_token, numero_telefone, status, webhook_url
         ) VALUES ($1, 'wn-velas', 'token-interno-velas-123', '5531983525816', 'open', 'https://warnat-panel.onrender.com/api/webhook/whatsapp')
         ON CONFLICT (instance_name)
         DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           status = 'open',
           updated_at = now()`,
        [velasTenantId]
      );
      console.log(`✅ Instância WhatsApp "wn-velas" vinculada ao tenant WN Velas artesanais.`);
    }

    // 9. Configurar Regras da IA e Catálogo para WN Velas artesanais
    const velasServicos = [
      { nome: 'Vela Aromática Pote de Vidro 140g - Baunilha Negra', faixa_preco: 'R$ 45,00', detalhes: 'Cera de coco 100% vegetal com pavio de algodão' },
      { nome: 'Vela Aromática Lata Retrô 90g - Lavanda Francesa', faixa_preco: 'R$ 35,00', detalhes: 'Relaxante e suave' },
      { nome: 'Home Spray / Difusor de Ambiente 200ml - Flor de Cerejeira', faixa_preco: 'R$ 55,00', detalhes: 'Alta fixação e aroma floral sofisticado' },
      { nome: 'Kit Trio de Mini Velas Aromáticas para Presente', faixa_preco: 'R$ 89,90', detalhes: 'Acompanha caixa especial e laço para presente' }
    ];

    await client.query(
      `INSERT INTO tenant_ai_configs (
         tenant_id, nicho_atuacao, tipo_negocio, objetivo_funil, tom_de_voz, sobre_empresa,
         pergunta_inicial_qualificacao, diretrizes_funil, politicas_comerciais, servicos_oferecidos,
         servicos_recusados, whatsapp_notificacao_humana
       ) VALUES (
         $1, 'Velas Artesanais Ecológicas & Aromas para Ambiente', 'produtos', 'venda_produtos',
         'amigavel_e_caloroso', 'Ateliê especializado na confecção artesanal de velas ecológicas de cera de coco e aromatizadores de ambiente premium.',
         'Você gostaria de conhecer nossos aromas e kits de velas para pronta-entrega ou está procurando lembrancinhas personalizadas para uma ocasião especial?',
         '1. Descobrir se é para presente ou para uso próprio;\n2. Apresentar os aromas mais pedidos;\n3. Informar valores e frete.',
         'Aceitamos Pix com 5% de desconto e Cartão de Crédito. Frete grátis para compras acima de R$ 180.',
         $2::jsonb,
         'Não fabricamos velas de parafina industrial comum.',
         '5531983525816'
       )
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         nicho_atuacao = EXCLUDED.nicho_atuacao,
         tipo_negocio = EXCLUDED.tipo_negocio,
         objetivo_funil = EXCLUDED.objetivo_funil,
         servicos_oferecidos = EXCLUDED.servicos_oferecidos,
         updated_at = now()`,
      [velasTenantId, JSON.stringify(velasServicos)]
    );
    console.log(`✅ Regras da IA e catálogo de produtos configurados para WN Velas artesanais.`);

    // 10. Provisionar Equipes / Departamentos Iniciais para os Tenants
    const checkDeptWarNat = await client.query(`SELECT id FROM departments WHERE tenant_id = $1 AND nome = $2`, [tenantId, 'Comercial & Vendas']);
    if (checkDeptWarNat.rowCount === 0) {
      await client.query(
        `INSERT INTO departments (tenant_id, nome, descricao, cor)
         VALUES ($1, 'Comercial & Vendas', 'Atendimento a novos leads, orçamentos e vendas', '#10b981')`,
        [tenantId]
      );
    }
    const checkSuporteWarNat = await client.query(`SELECT id FROM departments WHERE tenant_id = $1 AND nome = $2`, [tenantId, 'Suporte & Instalação']);
    if (checkSuporteWarNat.rowCount === 0) {
      await client.query(
        `INSERT INTO departments (tenant_id, nome, descricao, cor)
         VALUES ($1, 'Suporte & Instalação', 'Visitas técnicas, diagnóstico e manutenção CFTV', '#3b82f6')`,
        [tenantId]
      );
    }

    const checkVelasDept = await client.query(`SELECT id FROM departments WHERE tenant_id = $1 AND nome = $2`, [velasTenantId, 'Vendas & Pedidos']);
    if (checkVelasDept.rowCount === 0) {
      await client.query(
        `INSERT INTO departments (tenant_id, nome, descricao, cor)
         VALUES ($1, 'Vendas & Pedidos', 'Atendimento a pedidos de velas artesanais, aromas e presentes', '#f59e0b')`,
        [velasTenantId]
      );
    }
    console.log(`✅ Equipes e setores de atendimento iniciais configurados.`);

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
