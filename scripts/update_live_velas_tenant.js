const { query, pool } = require('../database/db');

async function main() {
  try {
    const tenants = await query("SELECT id, nome_empresa FROM tenants WHERE nome_empresa ILIKE '%vela%'");
    console.log('Tenants encontrados:', tenants.rows);

    for (const t of tenants.rows) {
      console.log(`\nAtualizando tenant ${t.nome_empresa} (${t.id})...`);

      const velasServicos = [
        { nome: 'Vela Aromática Pote de Vidro 140g - Baunilha Negra', faixa_preco: 'R$ 45,00', detalhes: 'Cera de coco 100% vegetal com pavio de algodão' },
        { nome: 'Vela Aromática Lata Retrô 90g - Lavanda Francesa', faixa_preco: 'R$ 35,00', detalhes: 'Relaxante e suave' },
        { nome: 'Home Spray / Difusor de Ambiente 200ml - Flor de Cerejeira', faixa_preco: 'R$ 55,00', detalhes: 'Alta fixação e aroma floral sofisticado' },
        { nome: 'Kit Trio de Mini Velas Aromáticas para Presente', faixa_preco: 'R$ 89,90', detalhes: 'Acompanha caixa especial e laço para presente' }
      ];

      const res = await query(`
        UPDATE tenant_ai_configs
        SET
          nicho_atuacao = 'Velas Artesanais Ecológicas & Aromas para Ambiente',
          tipo_negocio = 'produtos',
          objetivo_funil = 'venda_produtos',
          tom_de_voz = 'amigavel_e_caloroso',
          sobre_empresa = 'Ateliê especializado na confecção artesanal de velas ecológicas de cera de coco e aromatizadores de ambiente premium, feitas à mão com carinho e essências de alta fixação.',
          pergunta_inicial_qualificacao = 'Você gostaria de conhecer nossos aromas e kits de velas para pronta-entrega ou está procurando lembrancinhas personalizadas para uma ocasião especial?',
          diretrizes_funil = '1. Descobrir se é para presente ou para uso próprio;\n2. Apresentar os aromas mais pedidos (Baunilha Negra, Lavanda Francesa, Flor de Cerejeira);\n3. Perguntar a quantidade desejada;\n4. Solicitar CEP para cálculo de frete;\n5. Confirmar pedido e enviar dados para pagamento via Pix ou Cartão.',
          politicas_comerciais = 'Aceitamos pagamento via Pix (com 5% de desconto) e Cartão de Crédito. Enviamos para todo o Brasil via Sedex ou transportadora em até 2 dias úteis. Frete grátis para pedidos acima de R$ 180,00.',
          servicos_oferecidos = $2::jsonb,
          servicos_recusados = 'Não fabricamos velas de parafina industrial comum e não atendemos pedidos de atacado acima de 300 unidades sem prazo mínimo de 15 dias de antecedência.',
          taxa_manutencao_reais = null
        WHERE tenant_id = $1
        RETURNING *;
      `, [t.id, JSON.stringify(velasServicos)]);

      console.log('✅ Atualizado com sucesso para WN Velas Artesanais:', res.rows[0]);
    }
  } catch (err) {
    console.error('Erro:', err);
  } finally {
    process.exit(0);
  }
}

main();
