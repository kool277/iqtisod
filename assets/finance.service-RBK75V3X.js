import{S as e,d as t,u as n,v as r}from"./money-9WJBLqtM.js";import{d as i,h as a,u as o}from"./settings-DekYRfL6.js";import{$ as s,mt as c,nt as l,pt as u}from"./index-DmZ3Dnih.js";var d=[`image/png`,`image/jpeg`,`image/webp`,`image/gif`],f=d.join(`,`),p=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;function m(e,t,n=0){return t.every((t,r)=>e[n+r]===t)}var h=e=>[...e].map(e=>e.charCodeAt(0));function g(e,t){switch(e){case`png`:return m(t,[137,80,78,71,13,10,26,10]);case`jpeg`:return m(t,[255,216,255]);case`gif`:return m(t,h(`GIF87a`))||m(t,h(`GIF89a`));case`webp`:return m(t,h(`RIFF`))&&m(t,h(`WEBP`),8);default:return!1}}function _(e){let t=e.slice(e.indexOf(`,`)+1),n=t.endsWith(`==`)?2:+!!t.endsWith(`=`);return t.length/4*3-n}function v(t){if(t.length>Math.ceil(a.receiptBytes/3)*4+32)throw new e(`RECEIPT_SIZE`);let n=p.exec(t);if(!n||n[2].length%4!=0)throw new e(`RECEIPT_TYPE`);if(_(t)>a.receiptBytes)throw new e(`RECEIPT_SIZE`);let r=Uint8Array.from(atob(n[2].slice(0,16)),e=>e.charCodeAt(0));if(!g(n[1],r))throw new e(`RECEIPT_TYPE`)}var y=a.receiptBytes;function b(e){return e.roleName===`Admin`?{sql:`1 = 1`,params:[]}:e.groupId==null?{sql:`1 = 0`,params:[]}:{sql:`t.group_id = ?`,params:[e.groupId]}}function x(e){if(!i(e,o.READ_TRANSACTIONS)&&!i(e,o.READ_DASHBOARD))throw new r}function S(e){return{id:Number(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,icon:e.icon==null?null:String(e.icon),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function C(e){return{id:String(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,amountMinor:Number(e.amount_minor),currency:String(e.currency),categoryId:Number(e.category_id),userId:String(e.user_id),userEmail:String(e.user_email),groupId:Number(e.group_id),groupName:String(e.group_name),date:String(e.transaction_date),notes:e.notes==null?null:String(e.notes),receiptData:e.receipt_data==null?null:String(e.receipt_data),createdAt:String(e.created_at),updatedAt:String(e.updated_at),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function w(e,t){return t===`uz-Latn`?e.nameUzLatn:t===`uz-Cyrl`?e.nameUzCyrl:t===`ru`?e.nameRu:e.nameEn}function T(e){return x(e.user),e.db.query(`SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`).map(S)}function E(e,t){if(e.roleName!==`Admin`&&e.groupId!==t)throw new r}function D(t,r,i=null){if(r.type!==`INCOME`&&r.type!==`EXPENSE`)throw new e(`TYPE`);if(!s(r.currency))throw new e(`CURRENCY`);let o=n(String(r.amount),r.currency);if(!c(r.date))throw new e(`DATE`);let l=t.db.queryOne(`SELECT id, type FROM categories WHERE id = ?`,[r.categoryId]);if(!l||l.type!==r.type)throw new e(`CATEGORY`);if(t.db.queryValue(`SELECT id FROM groups WHERE id = ?`,[r.groupId])==null)throw new e(`GROUP`);E(t.user,r.groupId);let u=r.notes.trim();if(u.length>a.notesChars)throw new e(`NOTES`);let d=r.receiptData||null;if(d&&d!==i&&(v(d),t.db.sizeBytes()+d.length>a.databaseBudgetBytes))throw new e(`VAULT_FULL`);return{type:r.type,currency:r.currency,categoryId:r.categoryId,groupId:r.groupId,date:r.date,amountMinor:o,notes:u,receiptData:d}}function O(e){return{type:e.type,amountMinor:Number(e.amountMinor),currency:e.currency,date:e.date,categoryId:Number(e.categoryId),groupId:Number(e.groupId),notes:e.notes??null}}var k=`SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`;function A(e){return O({type:e.type,amountMinor:e.amount_minor,currency:e.currency,date:e.transaction_date,categoryId:e.category_id,groupId:e.group_id,notes:e.notes})}var j=`SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`;function M(e,t,n=`ALL`){if(!i(e.user,o.READ_TRANSACTIONS))throw new r;let a=b(e.user);return e.db.query(`${j}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${a.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,[t.start,t.end,...a.params,n,n]).map(C)}function N(e,t){if(!i(e.user,o.CREATE_TRANSACTION))throw new r;let n=D(e,t),a=crypto.randomUUID(),s=new Date().toISOString();return e.db.withTransaction(()=>{e.db.exec(`INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[a,n.type,n.amountMinor,n.currency,n.categoryId,e.user.id,n.groupId,n.date,n.notes||null,n.receiptData,s,s]),l(e.db,e.user.id,`TRANSACTION_CREATED`,`transaction`,a,O(n))}),a}function P(t,n,a){if(!i(t.user,o.UPDATE_TRANSACTION))throw new r;let s=t.db.queryOne(k,[n]);if(!s)throw new e(`REQUIRED`);E(t.user,Number(s.group_id));let c=t.db.queryValue(`SELECT receipt_data FROM transactions WHERE id = ?`,[n]),u=D(t,a,c==null?null:String(c));t.db.withTransaction(()=>{t.db.exec(`UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,[u.type,u.amountMinor,u.currency,u.categoryId,u.groupId,u.date,u.notes||null,u.receiptData,new Date().toISOString(),n]),l(t.db,t.user.id,`TRANSACTION_UPDATED`,`transaction`,n,{before:A(s),after:O(u)})})}function F(t,n){if(!i(t.user,o.DELETE_TRANSACTION))throw new r;let a=t.db.queryOne(k,[n]);if(!a)throw new e(`REQUIRED`);E(t.user,Number(a.group_id)),t.db.withTransaction(()=>{l(t.db,t.user.id,`TRANSACTION_DELETED`,`transaction`,n,{...A(a),userId:a.user_id}),t.db.exec(`DELETE FROM transactions WHERE id = ?`,[n])})}function I(e,n,a){if(!i(e.user,o.READ_DASHBOARD))throw new r;let s=b(e.user),c=e.currency,l=e.db.queryOne(`SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${s.sql}`,[n.start,n.end,c,...s.params]),d=Number(l?.income??0),f=Number(l?.expense??0),p=e.db.query(`SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${s.sql}
     GROUP BY month, t.type
     ORDER BY month`,[n.start,n.end,c,...s.params]),m=u(n.start,n.end),h=m.map(e=>{let t=p.find(t=>t.month===e&&t.type===`INCOME`);return Number(t?.total??0)}),g=m.map(e=>{let t=p.find(t=>t.month===e&&t.type===`EXPENSE`);return Number(t?.total??0)}),_=a===`uz-Latn`?`c.name_uz_latn`:a===`uz-Cyrl`?`c.name_uz_cyrl`:a===`ru`?`c.name_ru`:`c.name_en`,v=e.db.query(`SELECT ${_} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${s.sql}
       GROUP BY c.id
       ORDER BY total DESC`,[n.start,n.end,c,...s.params]).map(e=>({label:String(e.label),total:Number(e.total)})),y=e.db.query(`SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${s.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,[n.start,n.end,c,...s.params]).map(e=>({date:String(e.date),total:Number(e.total)})),x=e.user.roleName===`Admin`?`group`:`user`,S=x===`group`?e.db.query(`SELECT g.name AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN groups g ON g.id = t.group_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${s.sql}
           GROUP BY g.id
           ORDER BY total DESC`,[n.start,n.end,c,...s.params]):e.db.query(`SELECT u.email AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${s.sql}
           GROUP BY u.id
           ORDER BY total DESC`,[n.start,n.end,c,...s.params]),C=e.db.query(`SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${s.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,[n.start,n.end,c,...s.params]).map(e=>({currency:String(e.currency),income:Number(e.income),expense:Number(e.expense)}));return{income:d,expense:f,net:d-f,savingsRate:d>0?t(d-f,d,1):0,months:m,incomeByMonth:h,expenseByMonth:g,categories:v,trend:y,breakdown:S.map(e=>({label:String(e.label),total:Number(e.total)})),breakdownMode:x,otherCurrencies:C}}export{T as a,P as c,F as i,f as l,w as n,M as o,N as r,I as s,y as t,d as u};