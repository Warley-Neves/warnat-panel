// ==============================================================================
// SAAS MULTI-TENANT ENGINE - CUSTOMER MEMORY & APPOINTMENTS SERVICE
// Cumulative customer dossier (long-term memory) and appointments management
// ==============================================================================

import { query } from '../database/db';
import { CustomerProfile, Appointment, ChatMessage } from '../types/database.types';

export class CustomerService {
  /**
   * Localiza ou cria o dossiê permanente do cliente final para o tenant
   */
  public static async findOrCreateProfile(
    tenantId: string,
    remoteJid: string,
    initialData?: {
      nome?: string;
      telefone?: string;
      endereco_completo?: string;
      perfil_resumo?: string;
      metadados?: Record<string, unknown>;
    }
  ): Promise<CustomerProfile> {
    const existing = await query<CustomerProfile>(
      `SELECT id, tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados, created_at, updated_at
       FROM customer_profiles
       WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, remoteJid]
    );

    if (existing.rows.length > 0) {
      // Se houver novos dados fornecidos e o perfil atual tiver campos vazios, faz merge
      if (initialData && (initialData.nome || initialData.telefone || initialData.endereco_completo)) {
        const current = existing.rows[0];
        const updatedNome = initialData.nome || current.nome;
        const updatedTelefone = initialData.telefone || current.telefone;
        const updatedEndereco = initialData.endereco_completo || current.endereco_completo;

        const updateRes = await query<CustomerProfile>(
          `UPDATE customer_profiles
           SET nome = $1, telefone = $2, endereco_completo = $3, updated_at = NOW()
           WHERE id = $4
           RETURNING id, tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados, created_at, updated_at;`,
          [updatedNome, updatedTelefone, updatedEndereco, current.id]
        );
        return updateRes.rows[0];
      }
      return existing.rows[0];
    }

    const nome = initialData?.nome || null;
    const telefone = initialData?.telefone || remoteJid.replace(/@.*$/, '');
    const endereco = initialData?.endereco_completo || null;
    const resumo = initialData?.perfil_resumo || null;
    const metadados = initialData?.metadados ? JSON.stringify(initialData.metadados) : '{}';

    const insertRes = await query<CustomerProfile>(
      `INSERT INTO customer_profiles (
         tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados, created_at, updated_at;`,
      [tenantId, remoteJid, nome, telefone, endereco, resumo, metadados]
    );

    return insertRes.rows[0];
  }

  /**
   * Acumula informações no dossiê de longo prazo do cliente
   */
  public static async appendToDossier(
    tenantId: string,
    remoteJid: string,
    newSummaryEntry: string,
    metadataPatch?: Record<string, unknown>
  ): Promise<CustomerProfile> {
    const profile = await this.findOrCreateProfile(tenantId, remoteJid);

    const timestamp = new Date().toISOString().substring(0, 10);
    const formattedEntry = `[${timestamp}]: ${newSummaryEntry.trim()}`;

    const updatedResumo = profile.perfil_resumo
      ? `${profile.perfil_resumo}\n${formattedEntry}`
      : formattedEntry;

    const mergedMetadata = {
      ...(profile.metadados || {}),
      ...(metadataPatch || {}),
      last_updated: new Date().toISOString()
    };

    const res = await query<CustomerProfile>(
      `UPDATE customer_profiles
       SET perfil_resumo = $1, metadados = $2::jsonb, updated_at = NOW()
       WHERE id = $3
       RETURNING id, tenant_id, remote_jid, nome, telefone, endereco_completo, perfil_resumo, metadados, created_at, updated_at;`,
      [updatedResumo, JSON.stringify(mergedMetadata), profile.id]
    );

    return res.rows[0];
  }

  /**
   * Cria um agendamento ou ordem de serviço vinculada ao dossiê
   */
  public static async createAppointment(
    tenantId: string,
    data: {
      remote_jid: string;
      servico: string;
      data_agendada: Date | string;
      status?: 'agendado' | 'concluido' | 'cancelado';
      valor_estimado?: number;
      observacoes?: string;
    }
  ): Promise<Appointment> {
    const profile = await this.findOrCreateProfile(tenantId, data.remote_jid);

    const res = await query<Appointment>(
      `INSERT INTO appointments (
         tenant_id, customer_id, remote_jid, servico, data_agendada, status, valor_estimado, observacoes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tenant_id, customer_id, remote_jid, servico, data_agendada, status, valor_estimado, observacoes, created_at;`,
      [
        tenantId,
        profile.id,
        data.remote_jid,
        data.servico,
        new Date(data.data_agendada),
        data.status || 'agendado',
        data.valor_estimado || null,
        data.observacoes || null
      ]
    );

    return res.rows[0];
  }

  /**
   * Recupera histórico completo consolidado do cliente (Dossiê + Agendamentos)
   */
  public static async getCustomerHistory(
    tenantId: string,
    remoteJid: string
  ): Promise<{ profile: CustomerProfile | null; appointments: Appointment[]; recentMessages: ChatMessage[] }> {
    const profileRes = await query<CustomerProfile>(
      `SELECT * FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, remoteJid]
    );
    const profile = profileRes.rows[0] || null;

    const apptRes = await query<Appointment>(
      `SELECT * FROM appointments 
       WHERE tenant_id = $1 AND remote_jid = $2 
       ORDER BY data_agendada DESC;`,
      [tenantId, remoteJid]
    );

    const msgRes = await query<ChatMessage>(
      `SELECT m.* 
       FROM chat_messages m
       JOIN chat_sessions s ON m.session_id = s.id
       WHERE s.tenant_id = $1 AND s.remote_jid = $2
       ORDER BY m.created_at DESC
       LIMIT 10;`,
      [tenantId, remoteJid]
    );

    return {
      profile,
      appointments: apptRes.rows,
      recentMessages: msgRes.rows.reverse()
    };
  }
}
