import{C as e,d as t,f as n,y as r}from"./money-Dyn0G6Ok.js";import{u as i}from"./settings-CLQr00IG.js";import{a,o}from"./audit-chain-BMWLyA0T.js";import{$ as s,gt as c,ht as l,rt as u}from"./index-BX8mtVX3.js";var d=[`image/png`,`image/jpeg`,`image/webp`,`image/gif`],f=d.join(`,`),p=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;function m(e,t,n=0){return t.every((t,r)=>e[n+r]===t)}var h=e=>[...e].map(e=>e.charCodeAt(0));function g(e,t){switch(e){case`png`:return m(t,[137,80,78,71,13,10,26,10]);case`jpeg`:return m(t,[255,216,255]);case`gif`:return m(t,h(`GIF87a`))||m(t,h(`GIF89a`));case`webp`:return m(t,h(`RIFF`))&&m(t,h(`WEBP`),8);default:return!1}}function _(e){let t=e.slice(e.indexOf(`,`)+1),n=t.endsWith(`==`)?2:+!!t.endsWith(`=`);return t.length/4*3-n}function v(t){if(t.length>Math.ceil(i.receiptBytes/3)*4+32)throw new e(`RECEIPT_SIZE`);let n=p.exec(t);if(!n||n[2].length%4!=0)throw new e(`RECEIPT_TYPE`);if(_(t)>i.receiptBytes)throw new e(`RECEIPT_SIZE`);let r=Uint8Array.from(atob(n[2].slice(0,16)),e=>e.charCodeAt(0));if(!g(n[1],r))throw new e(`RECEIPT_TYPE`)}var y=i.receiptBytes;function b(e){return e.roleName===`Admin`?{sql:`1 = 1`,params:[]}:e.groupId==null?{sql:`1 = 0`,params:[]}:{sql:`t.group_id = ?`,params:[e.groupId]}}function x(e){if(!o(e,a.READ_TRANSACTIONS)&&!o(e,a.READ_DASHBOARD))throw new r}function S(e){return{id:Number(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,icon:e.icon==null?null:String(e.icon),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function C(e){return{id:String(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,amountMinor:Number(e.amount_minor),currency:String(e.currency),categoryId:Number(e.category_id),userId:String(e.user_id),userEmail:String(e.user_email),groupId:Number(e.group_id),groupName:String(e.group_name),date:String(e.transaction_date),notes:e.notes==null?null:String(e.notes),receiptData:e.receipt_data==null?null:String(e.receipt_data),createdAt:String(e.created_at),updatedAt:String(e.updated_at),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function w(e,t){return t===`uz-Latn`?e.nameUzLatn:t===`uz-Cyrl`?e.nameUzCyrl:t===`ru`?e.nameRu:e.nameEn}function T(e){return x(e.user),e.db.query(`SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`).map(S)}function E(e,t){if(e.roleName!==`Admin`&&e.groupId!==t)throw new r}function D(n,r,a=null){if(r.type!==`INCOME`&&r.type!==`EXPENSE`)throw new e(`TYPE`);if(!s(r.currency))throw new e(`CURRENCY`);let o=t(String(r.amount),r.currency);if(!c(r.date))throw new e(`DATE`);let l=n.db.queryOne(`SELECT id, type FROM categories WHERE id = ?`,[r.categoryId]);if(!l||l.type!==r.type)throw new e(`CATEGORY`);if(n.db.queryValue(`SELECT id FROM groups WHERE id = ?`,[r.groupId])==null)throw new e(`GROUP`);E(n.user,r.groupId);let u=r.notes.trim();if(u.length>i.notesChars)throw new e(`NOTES`);let d=r.receiptData||null;if(d&&d!==a&&(v(d),n.db.sizeBytes()+d.length>i.databaseBudgetBytes))throw new e(`VAULT_FULL`);return{type:r.type,currency:r.currency,categoryId:r.categoryId,groupId:r.groupId,date:r.date,amountMinor:o,notes:u,receiptData:d}}function O(e){return{type:e.type,amountMinor:Number(e.amountMinor),currency:e.currency,date:e.date,categoryId:Number(e.categoryId),groupId:Number(e.groupId),notes:e.notes??null}}var k=`SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`;function A(e){return O({type:e.type,amountMinor:e.amount_minor,currency:e.currency,date:e.transaction_date,categoryId:e.category_id,groupId:e.group_id,notes:e.notes})}var j=`SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`;function M(e,t,n=`ALL`){if(!o(e.user,a.READ_TRANSACTIONS))throw new r;let i=b(e.user);return e.db.query(`${j}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${i.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,[t.start,t.end,...i.params,n,n]).map(C)}function N(e,t){if(!o(e.user,a.CREATE_TRANSACTION))throw new r;let n=D(e,t),i=crypto.randomUUID(),s=new Date().toISOString();return e.db.withTransaction(()=>{e.db.exec(`INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[i,n.type,n.amountMinor,n.currency,n.categoryId,e.user.id,n.groupId,n.date,n.notes||null,n.receiptData,s,s]),u(e.db,e.user.id,`TRANSACTION_CREATED`,`transaction`,i,O(n))}),i}function P(t,n,i){if(!o(t.user,a.UPDATE_TRANSACTION))throw new r;let s=t.db.queryOne(k,[n]);if(!s)throw new e(`REQUIRED`);E(t.user,Number(s.group_id));let c=t.db.queryValue(`SELECT receipt_data FROM transactions WHERE id = ?`,[n]),l=D(t,i,c==null?null:String(c));t.db.withTransaction(()=>{t.db.exec(`UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,[l.type,l.amountMinor,l.currency,l.categoryId,l.groupId,l.date,l.notes||null,l.receiptData,new Date().toISOString(),n]),u(t.db,t.user.id,`TRANSACTION_UPDATED`,`transaction`,n,{before:A(s),after:O(l)})})}function F(t,n){if(!o(t.user,a.DELETE_TRANSACTION))throw new r;let i=t.db.queryOne(k,[n]);if(!i)throw new e(`REQUIRED`);E(t.user,Number(i.group_id)),t.db.withTransaction(()=>{u(t.db,t.user.id,`TRANSACTION_DELETED`,`transaction`,n,{...A(i),userId:i.user_id}),t.db.exec(`DELETE FROM transactions WHERE id = ?`,[n])})}function I(t,n){let r=b(t);if(n==null)return r;if(!Number.isSafeInteger(n)||n<=0)throw new e(`GROUP`);return E(t,n),{sql:`(${r.sql}) AND t.group_id = ?`,params:[...r.params,n]}}function L(e,t,i,s=null){if(!o(e.user,a.READ_DASHBOARD))throw new r;let c=I(e.user,s),u=e.currency,d=e.db.queryOne(`SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${c.sql}`,[t.start,t.end,u,...c.params]),f=Number(d?.income??0),p=Number(d?.expense??0),m=e.db.query(`SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${c.sql}
     GROUP BY month, t.type
     ORDER BY month`,[t.start,t.end,u,...c.params]),h=l(t.start,t.end),g=h.map(e=>{let t=m.find(t=>t.month===e&&t.type===`INCOME`);return Number(t?.total??0)}),_=h.map(e=>{let t=m.find(t=>t.month===e&&t.type===`EXPENSE`);return Number(t?.total??0)}),v=i===`uz-Latn`?`c.name_uz_latn`:i===`uz-Cyrl`?`c.name_uz_cyrl`:i===`ru`?`c.name_ru`:`c.name_en`,y=e.db.query(`SELECT ${v} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${c.sql}
       GROUP BY c.id
       ORDER BY total DESC`,[t.start,t.end,u,...c.params]).map(e=>({label:String(e.label),total:Number(e.total)})),b=e.db.query(`SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${c.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,[t.start,t.end,u,...c.params]).map(e=>({date:String(e.date),total:Number(e.total)})),x=e.user.roleName===`Admin`&&s==null?`group`:`user`,S=x===`group`?e.db.query(`SELECT g.name AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN groups g ON g.id = t.group_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${c.sql}
           GROUP BY g.id
           ORDER BY total DESC`,[t.start,t.end,u,...c.params]):e.db.query(`SELECT u.email AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${c.sql}
           GROUP BY u.id
           ORDER BY total DESC`,[t.start,t.end,u,...c.params]),C=e.db.query(`SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${c.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,[t.start,t.end,u,...c.params]).map(e=>({currency:String(e.currency),income:Number(e.income),expense:Number(e.expense)}));return{income:f,expense:p,net:f-p,savingsRate:f>0?n(f-p,f,1):0,months:h,incomeByMonth:g,expenseByMonth:_,categories:y,trend:b,breakdown:S.map(e=>({label:String(e.label),total:Number(e.total)})),breakdownMode:x,otherCurrencies:C}}export{T as a,b as c,d,F as i,P as l,w as n,M as o,N as r,L as s,y as t,f as u};