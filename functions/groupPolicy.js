export const RESTRICTED_GROUP_NAME = 'SQUAD Web3 | @AlexCPO_';

function normalizeGroupName(name) {
    return String(name || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function isRestrictedGroupName(groupName) {
    return normalizeGroupName(groupName) === normalizeGroupName(RESTRICTED_GROUP_NAME);
}
