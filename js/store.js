// js/store.js
// 依賴：js/config.js、Supabase JS SDK v2（CDN）

(function () {
  const { createClient } = window.supabase;
  const _db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  window.Store = {

    // ── Auth ──────────────────────────────────────────────────

    async signIn(password) {
      const { data, error } = await _db.auth.signInWithPassword({
        email: window.ADMIN_EMAIL,
        password
      });
      if (error) throw error;
      return data;
    },

    async signOut() {
      await _db.auth.signOut();
    },

    async isAuthenticated() {
      const { data: { session } } = await _db.auth.getSession();
      return !!session;
    },

    // ── Participants ──────────────────────────────────────────

    async getParticipants() {
      const { data, error } = await _db
        .from('participants')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },

    async getEligible() {
      const { data, error } = await _db
        .from('participants')
        .select('*')
        .eq('eligible', true);
      if (error) throw error;
      return data;
    },

    async getParticipantById(id) {
      const { data } = await _db
        .from('participants')
        .select('*')
        .eq('id', id)
        .single();
      return data;
    },

    async addParticipant(name, department, employeeNo) {
      const { data, error } = await _db
        .from('participants')
        .insert({ name, department, employee_no: employeeNo || '' })
        .select()
        .single();
      if (error) throw error;
      await this.addLog('PARTICIPANT_ADD', `新增人員：${name}（${department}）`);
      return data;
    },

    async updateParticipant(id, updates) {
      const { data, error } = await _db
        .from('participants')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async deleteParticipant(id) {
      const p = await this.getParticipantById(id);
      const { error } = await _db.from('participants').delete().eq('id', id);
      if (error) throw error;
      if (p) await this.addLog('PARTICIPANT_DELETE', `刪除人員：${p.name}（${p.department}）`);
    },

    async importParticipants(csvText) {
      const text = csvText.replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const rows = lines.slice(1);

      let added = 0, skipped = 0;
      const errors = [];

      const existing = await this.getParticipants();
      const existingEmpNos = new Set(existing.map(p => p.employee_no).filter(Boolean));

      const batch = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const toInsert = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.trim()) continue;

        const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        const name = cols[0];
        const department = cols[1];
        const employeeNo = cols[2] || '';

        if (!name || !department) {
          errors.push(`第 ${i + 2} 列：姓名或部門空白`);
          continue;
        }
        if (employeeNo && existingEmpNos.has(employeeNo)) {
          skipped++;
          continue;
        }

        toInsert.push({ name, department, employee_no: employeeNo, import_batch: batch });
        if (employeeNo) existingEmpNos.add(employeeNo);
      }

      if (toInsert.length > 0) {
        const { error } = await _db.from('participants').insert(toInsert);
        if (error) throw error;
        added = toInsert.length;
      }

      await this.addLog('IMPORT', `匯入人員：成功 ${added} 筆，略過 ${skipped} 筆`);
      return { added, skipped, errors };
    },

    // ── Prizes ────────────────────────────────────────────────

    async getPrizes() {
      const { data, error } = await _db
        .from('prizes')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data;
    },

    async addPrize(name, quantity, sortOrder) {
      const { data, error } = await _db
        .from('prizes')
        .insert({ name, quantity: parseInt(quantity), sort_order: parseInt(sortOrder) })
        .select()
        .single();
      if (error) throw error;
      await this.addLog('PRIZE_ADD', `新增獎品：${name}（數量：${quantity}）`);
      return data;
    },

    async updatePrize(id, updates) {
      const { data, error } = await _db
        .from('prizes')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      await this.addLog('PRIZE_EDIT', `編輯獎品：${data.name}`);
      return data;
    },

    async importPrizes(prizesData) {
      // prizesData: [{name, quantity, sortOrder}]
      let added = 0;
      const errors = [];

      for (let i = 0; i < prizesData.length; i++) {
        const row = prizesData[i];
        if (!row.name || !row.name.trim()) {
          errors.push(`第 ${i + 1} 列：獎品名稱空白`);
          continue;
        }
        try {
          await this.addPrize(row.name.trim(), row.quantity || 1, row.sortOrder || (i + 1));
          added++;
        } catch (e) {
          errors.push(`第 ${i + 1} 列（${row.name}）：${e.message}`);
        }
      }

      if (added > 0) await this.addLog('PRIZE_IMPORT', `匯入獎品：成功 ${added} 筆`);
      return { added, errors };
    },

    async deletePrize(id) {
      const { data: results } = await _db
        .from('draw_results')
        .select('id')
        .eq('prize_id', id)
        .limit(1);

      if (results && results.length > 0) {
        const { data, error } = await _db
          .from('prizes')
          .update({ active: false })
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        return { deactivated: true };
      }

      const { error } = await _db.from('prizes').delete().eq('id', id);
      if (error) throw error;
      return { deleted: true };
    },

    // ── Draw Core ─────────────────────────────────────────────

    async draw(prizeId) {
      const eligible = await this.getEligible();
      if (eligible.length === 0) return null;

      const { data: prize } = await _db
        .from('prizes')
        .select('*')
        .eq('id', prizeId)
        .single();

      if (!prize || !prize.active) return null;
      if (prize.winners_drawn >= prize.quantity) return null;

      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      const idx = arr[0] % eligible.length;
      const winner = eligible[idx];

      const { data: result, error } = await _db
        .from('draw_results')
        .insert({
          prize_id: prizeId,
          prize_name: prize.name,
          participant_id: winner.id,
          participant_name: winner.name,
          participant_dept: winner.department,
          participant_employee_no: winner.employee_no || ''
        })
        .select()
        .single();
      if (error) throw error;

      await _db.from('participants').update({ eligible: false }).eq('id', winner.id);
      await _db.from('prizes').update({ winners_drawn: prize.winners_drawn + 1 }).eq('id', prizeId);
      await this.addLog('DRAW', `抽出：${winner.name}（${winner.department}）獲得 ${prize.name}`);

      return result;
    },

    async revoke(resultId, reason) {
      const { data: result } = await _db
        .from('draw_results')
        .select('*')
        .eq('id', resultId)
        .single();

      if (!result || result.revoked) return;

      await _db.from('draw_results').update({
        revoked: true,
        revoked_at: new Date().toISOString(),
        revoked_reason: reason
      }).eq('id', resultId);

      await _db.from('participants').update({ eligible: true }).eq('id', result.participant_id);

      const { data: prize } = await _db
        .from('prizes')
        .select('winners_drawn')
        .eq('id', result.prize_id)
        .single();

      if (prize) {
        await _db.from('prizes')
          .update({ winners_drawn: Math.max(0, prize.winners_drawn - 1) })
          .eq('id', result.prize_id);
      }

      await this.addLog('REVOKE', `撤銷：${result.participant_name} 的 ${result.prize_name}，原因：${reason}`);
    },

    // ── Results & Logs ────────────────────────────────────────

    async getResults() {
      const { data, error } = await _db
        .from('draw_results')
        .select('*')
        .order('drawn_at', { ascending: true });
      if (error) throw error;
      return data;
    },

    async getResultsByPrize(prizeId) {
      const { data, error } = await _db
        .from('draw_results')
        .select('*')
        .eq('prize_id', prizeId)
        .order('drawn_at', { ascending: true });
      if (error) throw error;
      return data;
    },

    async searchResults(keyword) {
      const { data, error } = await _db
        .from('draw_results')
        .select('*')
        .or(`participant_name.ilike.%${keyword}%,participant_dept.ilike.%${keyword}%,participant_employee_no.ilike.%${keyword}%`)
        .order('drawn_at', { ascending: true });
      if (error) throw error;
      return data;
    },

    async getLogs() {
      const { data, error } = await _db
        .from('logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },

    async addLog(action, detail) {
      try {
        await _db.from('logs').insert({ action, detail });
      } catch (_) { /* 靜默失敗，不影響主流程 */ }
    },

    // ── Export / Clear ────────────────────────────────────────

    async exportResultsCsv() {
      const results = await this.getResults();
      const header = '獎品,姓名,部門,員工編號,抽出時間,狀態';
      const rows = results.map(r => [
        `"${r.prize_name}"`,
        `"${r.participant_name}"`,
        `"${r.participant_dept}"`,
        `"${r.participant_employee_no}"`,
        `"${new Date(r.drawn_at).toLocaleString('zh-TW')}"`,
        r.revoked ? '已重抽' : '有效'
      ].join(','));
      return '\uFEFF' + [header, ...rows].join('\r\n');
    },

    async clearAll() {
      const notExist = '00000000-0000-0000-0000-000000000000';
      await _db.from('draw_results').delete().neq('id', notExist);
      await _db.from('logs').delete().neq('id', notExist);
      await _db.from('prizes').delete().neq('id', notExist);
      await _db.from('participants').delete().neq('id', notExist);
    },

    // ── Realtime ──────────────────────────────────────────────

    subscribeResults(callback) {
      return _db
        .channel('draw_results_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'draw_results' }, callback)
        .subscribe();
    },

    subscribePrizes(callback) {
      return _db
        .channel('prizes_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'prizes' }, callback)
        .subscribe();
    },

    subscribeParticipants(callback) {
      return _db
        .channel('participants_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'participants' }, callback)
        .subscribe();
    },

    getDb() { return _db; }
  };
})();
