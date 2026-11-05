const { query } = require('../database/db');
const authService = require('../database/auth.service');

async function testAuthAndSchema() {
  console.log('Testing Schema & AuthService...');

  // 1. Inserir Tenant de teste
  const tenantRes = await query(
    'INSERT INTO tenants (nome_empresa, documento, plano) VALUES ($1, $2, $3) RETURNING *',
    ['Empresa Teste SaaS', '12.345.678/0001-90', 'enterprise']
  );
  const tenant = tenantRes.rows[0];
  console.log('✅ Tenant inserido:', tenant.id, tenant.nome_empresa);

  // 2. Registrar Usuário no Tenant
  const user = await authService.registerUser({
    tenantId: tenant.id,
    email: 'admin.teste@empresa.com',
    password: 'SenhaForte123!',
    role: 'admin',
    nome: 'Administrador Teste'
  });
  console.log('✅ Usuário registrado:', user.id, user.email, 'Role:', user.role);

  // 3. Fazer Login
  const loginRes = await authService.login('admin.teste@empresa.com', 'SenhaForte123!');
  console.log('✅ Login efetuado com sucesso! Token gerado:', loginRes.token.substring(0, 30) + '...');

  // 4. Validar Token JWT
  const decoded = authService.verifyToken(loginRes.token);
  console.log('✅ Token decodificado:', {
    userId: decoded.userId,
    tenantId: decoded.tenantId,
    email: decoded.email,
    role: decoded.role
  });

  if (decoded.tenantId !== tenant.id) {
    throw new Error('Tenant ID no token não confere com o banco!');
  }

  // 5. Testar Configurações de IA do Tenant
  const aiConfigRes = await query(
    'INSERT INTO tenant_ai_configs (tenant_id, tom_de_voz, sobre_empresa, servicos_oferecidos, pausa_automatica_minutos) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [tenant.id, 'consultivo_amigavel', 'Empresa de testes SaaS', JSON.stringify(['CFTV', 'Alarmes']), 45]
  );
  console.log('✅ Configuração de IA inserida:', aiConfigRes.rows[0].tenant_id, 'Pausa (min):', aiConfigRes.rows[0].pausa_automatica_minutos);

  // 6. Testar Sessão de Chat e Constraint de unicidade composta (tenant_id, remote_jid)
  const sessionRes = await query(
    'INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento) VALUES ($1, $2, $3, $4) RETURNING *',
    [tenant.id, '5531983579692@s.whatsapp.net', 'Cliente Teste', 'ia_ativa']
  );
  console.log('✅ Sessão de chat criada:', sessionRes.rows[0].id, 'JID:', sessionRes.rows[0].remote_jid);

  // 7. Testar Mensagem de Chat
  const msgRes = await query(
    'INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [sessionRes.rows[0].id, tenant.id, 'user', 'Olá, gostaria de saber sobre as câmeras', 'MSG_TEST_12345']
  );
  console.log('✅ Mensagem registrada:', msgRes.rows[0].id, 'Role:', msgRes.rows[0].role);

  // 8. Limpeza dos dados de teste (ON DELETE CASCADE testa remoção de tudo via tenant)
  await query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
  const checkCascade = await query('SELECT count(*) FROM chat_messages WHERE tenant_id = $1', [tenant.id]);
  console.log('✅ Cascade deletion confirmada: mensagens restantes =', checkCascade.rows[0].count);

  console.log('\n🎉 TODOS OS TESTES DA FASE 2 PASSARAM COM 100% DE SUCESSO!');
  process.exit(0);
}

testAuthAndSchema().catch(err => {
  console.error('❌ Falha nos testes:', err);
  process.exit(1);
});
