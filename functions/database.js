// Supabase Database
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lxqyacryiizzcyrkcfya.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4cXlhY3J5aWl6emN5cmtjZnlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4MjE1ODQsImV4cCI6MjA3OTM5NzU4NH0.hiZwcpP-3O8miqAkZ9ht9QGtngJw8Hc0Gg6xAaMQRAE';

export const supabase = createClient(supabaseUrl, supabaseKey);

// Strikes
export async function getStrikes(userId) {
    const { data } = await supabase.from('strikes').select('*').eq('user_id', userId).single();
    return data || { count: 0, violations: [] };
}

export async function addStrike(userId, violation) {
    const current = await getStrikes(userId);
    const newCount = current.count + 1;
    const violations = [...(current.violations || []), { ...violation, date: new Date().toISOString() }];
    
    await supabase.from('strikes').upsert({ user_id: userId, count: newCount, violations });
    return newCount;
}

export async function resetStrikes(userId) {
    await supabase.from('strikes').delete().eq('user_id', userId);
}

// Banned Words
export async function getBannedWords() {
    const { data } = await supabase.from('banned_words').select('word');
    return data ? data.map(row => row.word) : [];
}

export async function addBannedWord(word) {
    const { error } = await supabase.from('banned_words').insert({ word: word.toLowerCase() });
    return !error;
}

export async function removeBannedWord(word) {
    const { error } = await supabase.from('banned_words').delete().eq('word', word.toLowerCase());
    return !error;
}

// Allowed Groups
export async function getAllowedGroups() {
    const { data } = await supabase.from('allowed_groups').select('name');
    return data ? data.map(row => row.name) : [];
}

export async function addAllowedGroup(name) {
    const { error } = await supabase.from('allowed_groups').insert({ name });
    return !error;
}

export async function removeAllowedGroup(name) {
    const { error } = await supabase.from('allowed_groups').delete().eq('name', name);
    return !error;
}

// Admins
export async function getAdmins() {
    const { data } = await supabase.from('admins').select('user_id');
    return data ? data.map(row => row.user_id) : [];
}

export async function addAdmin(userId) {
    const { error } = await supabase.from('admins').insert({ user_id: userId });
    return !error;
}

export async function removeAdmin(userId) {
    const { error } = await supabase.from('admins').delete().eq('user_id', userId);
    return !error;
}

// Lembretes
export async function saveLembrete(groupId, config) {
    await supabase.from('lembretes').upsert({ group_id: groupId, config });
}

export async function getLembretes() {
    const { data } = await supabase.from('lembretes').select('*');
    return data || [];
}

export async function deleteLembrete(groupId) {
    await supabase.from('lembretes').delete().eq('group_id', groupId);
}

// Scheduled Messages
export async function saveScheduledMessage(id, groupId, time, message, timestamp) {
    await supabase.from('scheduled_messages').insert({ id, group_id: groupId, time, message, timestamp });
}

export async function getScheduledMessages() {
    const { data } = await supabase.from('scheduled_messages').select('*');
    return data || [];
}

export async function deleteScheduledMessage(id) {
    await supabase.from('scheduled_messages').delete().eq('id', id);
}

// Admin Action Logs
export async function logAdminAction(adminId, action, targetId, groupId, details) {
    await supabase.from('admin_logs').insert({
        admin_id: adminId,
        action,
        target_id: targetId,
        group_id: groupId,
        details,
        timestamp: new Date().toISOString()
    });
}

export async function getAdminLogs(limit = 50) {
    const { data } = await supabase.from('admin_logs').select('*').order('timestamp', { ascending: false }).limit(limit);
    return data || [];
}

// Leads
export async function saveLead(leadData) {
    const { error } = await supabase.from('leads').upsert({
        user_id: leadData.id,
        phone: leadData.phone,
        last_message: leadData.lastMessage,
        intent: leadData.intent,
        confidence: leadData.confidence,
        conversation_count: leadData.conversationCount,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    return !error;
}

export async function getLeads(limit = 50) {
    const { data } = await supabase.from('leads').select('*').order('updated_at', { ascending: false }).limit(limit);
    return data || [];
}

export async function getLeadByUserId(userId) {
    const { data } = await supabase.from('leads').select('*').eq('user_id', userId).single();
    return data;
}

// Allowed Users
export async function getAllowedUsers() {
    const { data } = await supabase.from('allowed_users').select('user_id');
    return data ? data.map(row => row.user_id) : [];
}

export async function addAllowedUser(userId, name = null) {
    const { error } = await supabase.from('allowed_users').insert({ user_id: userId, name });
    return !error;
}

export async function removeAllowedUser(userId) {
    const { error } = await supabase.from('allowed_users').delete().eq('user_id', userId);
    return !error;
}

// Blacklist
export async function getBlacklist() {
    const { data } = await supabase.from('blacklist').select('*');
    return data || [];
}

export async function addToBlacklist(userId, reason = null) {
    const { error } = await supabase.from('blacklist').insert({ user_id: userId, reason });
    return !error;
}

export async function removeFromBlacklist(userId) {
    const { error } = await supabase.from('blacklist').delete().eq('user_id', userId);
    return !error;
}

export async function isBlacklisted(userId) {
    const { data } = await supabase.from('blacklist').select('user_id').eq('user_id', userId).single();
    return !!data;
}

// Auto-Promoção
export async function getPromoGroups() {
    const { data } = await supabase.from('promo_groups').select('*').order('created_at', { ascending: false });
    return data || [];
}

export async function addPromoGroup(groupId, groupName) {
    const { error } = await supabase.from('promo_groups').insert({ group_id: groupId, group_name: groupName });
    return !error;
}

export async function removePromoGroup(groupId) {
    const { error } = await supabase.from('promo_groups').delete().eq('group_id', groupId);
    return !error;
}

export async function updatePromoGroupLastSent(groupId) {
    const { error } = await supabase.from('promo_groups').update({ last_promo: new Date().toISOString() }).eq('group_id', groupId);
    return !error;
}

export async function getPromoConfig() {
    const { data } = await supabase.from('promo_config').select('*').single();
    return data || { enabled: true, intervalHours: 6 };
}

export async function setPromoConfig(key, value) {
    const { error } = await supabase.from('promo_config').upsert({ id: 1, [key]: value });
    return !error;
}

export async function getPromoMessages() {
    const { data } = await supabase.from('promo_messages').select('*').eq('active', true);
    return data || [];
}

export async function addPromoMessage(message) {
    const { error } = await supabase.from('promo_messages').insert({ message, active: true });
    return !error;
}
