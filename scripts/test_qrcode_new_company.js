const { query, pool } = require('../database/db');
const authService = require('../database/auth.service');
const evolutionService = require('../services/evolution.service');

async function testNewCompanyQRCode() {
  console.log('================================================================');
  console.log('🧪 TESTE DE AUTO-PROVISIONAMENTO E QR CODE PARA NOVA EMPRESA');
  console.log('================================================================\n');

  const testEmail = `empresa.qr.${Date.now()}@teste.com`;
  const companyName = `Nova Empresa CFTV ${Date.now().toString().slice(-4)}`;

  console.log(`1. Cadastrando nova empresa: "${companyName}" (${testEmail})...`);
  const regResult = await authService.registerTenantAndAdmin({
    nome_empresa: companyName,
    documento: '12.345.678/0001-90',
    plano: 'start',
    nome: 'Carlos Administrador',
    email: testEmail,
    password: 'SenhaSegura123!',
    sobre_empresa: 'Empresa especializada em instalação de câmeras.'
  });

  const tenantId = regResult.tenant.id;
  console.log(`✅ Empresa cadastrada com ID: ${tenantId}`);

  // 2. Verifica se a instância foi inserida no banco
  console.log('\n2. Verificando instância no banco de dados (tenant_whatsapp_instances)...');
  const instRes = await query(
    `SELECT id, instance_name, status FROM tenant_whatsapp_instances WHERE tenant_id = $1`,
    [tenantId]
  );

  if (instRes.rowCount === 0) {
    console.error('❌ FALHA: Nenhuma instância foi provisionada no banco de dados!');
    process.exit(1);
  }

  const instanceName = instRes.rows[0].instance_name;
  console.log(`✅ Instância registrada no banco: "${instanceName}" (Status: ${instRes.rows[0].status})`);

  // 3. Testa obtenção de QR Code
  console.log(`\n3. Solicitando QR Code via evolutionService para "${instanceName}"...`);
  const qrData = await evolutionService.getQRCode(instanceName);

  console.log('Resultado getQRCode:');
  console.log(`- Success: ${qrData.success}`);
  console.log(`- InstanceName: ${qrData.instanceName}`);
  console.log(`- Has Base64: ${!!qrData.base64}`);
  console.log(`- Base64 Length: ${qrData.base64 ? qrData.base64.length : 0}`);
  console.log(`- Base64 StartsWith: ${qrData.base64 ? qrData.base64.slice(0, 30) : 'N/A'}`);

  if (!qrData.base64) {
    console.error('❌ FALHA: QR Code base64 não retornado!');
    process.exit(1);
  }

  console.log('\n✅ SUCESSO: QR Code gerado perfeitamente para a nova empresa!');

  // 4. Limpeza
  console.log('\n4. Limpando dados de teste...');
  try {
    await evolutionService.request(`/instance/delete/${instanceName}`, { method: 'DELETE' });
  } catch (e) {}

  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  console.log('✅ Dados de teste removidos do banco.');

  await pool.end();
  console.log('\n🎉 TESTE CONCLUÍDO COM 100% DE ÊXITO!');
}

testNewCompanyQRCode().catch(err => {
  console.error('❌ Erro inesperado no teste:', err);
  process.exit(1);
});
