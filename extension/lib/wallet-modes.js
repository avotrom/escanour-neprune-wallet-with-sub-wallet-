export const WALLET_MODES=['standard','refresh','encrypted'];
export function activeMode(s={}) {
  if(s.activeMode==='encrypted'&&s.network!=='main'&&s.createdWallets?.encrypted===true&&s.privateNotifications===true)return 'encrypted';
  if(s.activeMode==='refresh'&&s.createdWallets?.refresh===true&&s.autoRefresh===true)return 'refresh';
  return 'standard';
}
export function activityForMode(list,mode){
  return list.filter(e=>(e.walletMode || (e.kind==='received'&&(e.addressKind==='private-app'||e.privateDowngrade)?'encrypted':'standard'))===mode);
}
export function addressKind(kind='generation'){if(['generation','ec-hybrid'].includes(kind))return kind;throw new Error('Unknown receiving address kind.');}
