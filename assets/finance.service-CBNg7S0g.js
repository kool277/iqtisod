import{At as e,L as t,wt as n}from"./vault-core-CKtm37x0.js";import{j as r}from"./auth.service-DUdRSgh1.js";import{i,n as a,t as o}from"./rbac-p3Q15qXv.js";import{r as s}from"./audit.service-D4t8JEtv.js";import{d as c,f as l}from"./money-CYPiCbX1.js";import{at as u,it as d}from"./index-44hB3Vca.js";import{n as f,r as p}from"./capacity-dMbzt7h3.js";var m=[`image/png`,`image/jpeg`,`image/webp`,`image/gif`],h=m.join(`,`),g=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;function _(e,t,n=0){return t.every((t,r)=>e[n+r]===t)}var v=e=>[...e].map(e=>e.charCodeAt(0));function y(e,t){switch(e){case`png`:return _(t,[137,80,78,71,13,10,26,10]);case`jpeg`:return _(t,[255,216,255]);case`gif`:return _(t,v(`GIF87a`))||_(t,v(`GIF89a`));case`webp`:return _(t,v(`RIFF`))&&_(t,v(`WEBP`),8);default:return!1}}function b(e){let t=e.slice(e.indexOf(`,`)+1),n=t.endsWith(`==`)?2:+!!t.endsWith(`=`);return t.length/4*3-n}function x(n){if(n.length>Math.ceil(t.receiptBytes/3)*4+32)throw new e(`RECEIPT_SIZE`);let r=g.exec(n);if(!r||r[2].length%4!=0)throw new e(`RECEIPT_TYPE`);if(b(n)>t.receiptBytes)throw new e(`RECEIPT_SIZE`);let i=Uint8Array.from(atob(r[2].slice(0,16)),e=>e.charCodeAt(0));if(!y(r[1],i))throw new e(`RECEIPT_TYPE`)}var S=t.receiptBytes;function C(e){return i(e)?{sql:`1 = 1`,params:[]}:e.groupId==null?{sql:`1 = 0`,params:[]}:{sql:`t.group_id = ?`,params:[e.groupId]}}function w(e){if(!a(e,o.READ_TRANSACTIONS)&&!a(e,o.READ_DASHBOARD))throw new n}function T(e){return{id:Number(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,icon:e.icon==null?null:String(e.icon),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function E(e){return{id:String(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,amountMinor:Number(e.amount_minor),currency:String(e.currency),categoryId:Number(e.category_id),userId:String(e.user_id),userEmail:String(e.user_email),groupId:Number(e.group_id),groupName:String(e.group_name),date:String(e.transaction_date),notes:e.notes==null?null:String(e.notes),receiptData:e.receipt_data==null?null:String(e.receipt_data),createdAt:String(e.created_at),updatedAt:String(e.updated_at),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function D(e,t){return t===`uz-Latn`?e.nameUzLatn:t===`uz-Cyrl`?e.nameUzCyrl:t===`ru`?e.nameRu:e.nameEn}function O(e){return w(e.user),e.db.query(`SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`).map(T)}function k(e,t){if(!i(e)&&e.groupId!==t)throw new n}function A(n,i,a=null){if(i.type!==`INCOME`&&i.type!==`EXPENSE`)throw new e(`TYPE`);if(!r(i.currency))throw new e(`CURRENCY`);let o=c(String(i.amount),i.currency);if(!u(i.date))throw new e(`DATE`);let s=n.db.queryOne(`SELECT id, type FROM categories WHERE id = ?`,[i.categoryId]);if(!s||s.type!==i.type)throw new e(`CATEGORY`);if(n.db.queryValue(`SELECT id FROM groups WHERE id = ?`,[i.groupId])==null)throw new e(`GROUP`);k(n.user,i.groupId);let l=i.notes.trim();if(l.length>t.notesChars)throw new e(`NOTES`);let d=i.receiptData||null;if(d&&d!==a&&(x(d),n.db.usedBytes()+d.length>p(f()).budgetBytes))throw new e(`VAULT_FULL`);return{type:i.type,currency:i.currency,categoryId:i.categoryId,groupId:i.groupId,date:i.date,amountMinor:o,notes:l,receiptData:d}}function j(e){return{type:e.type,amountMinor:Number(e.amountMinor),currency:e.currency,date:e.date,categoryId:Number(e.categoryId),groupId:Number(e.groupId),notes:e.notes??null}}var M=`SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`;function N(e){return j({type:e.type,amountMinor:e.amount_minor,currency:e.currency,date:e.transaction_date,categoryId:e.category_id,groupId:e.group_id,notes:e.notes})}var P=`SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`;function F(e,t,r=`ALL`){if(!a(e.user,o.READ_TRANSACTIONS))throw new n;let i=C(e.user);return e.db.query(`${P}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${i.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,[t.start,t.end,...i.params,r,r]).map(E)}function I(e,t){if(!a(e.user,o.CREATE_TRANSACTION))throw new n;let r=A(e,t),i=crypto.randomUUID(),c=new Date().toISOString();return e.db.withTransaction(()=>{e.db.exec(`INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[i,r.type,r.amountMinor,r.currency,r.categoryId,e.user.id,r.groupId,r.date,r.notes||null,r.receiptData,c,c]),s(e.db,e.user.id,`TRANSACTION_CREATED`,`transaction`,i,j(r))}),i}function L(t,r,i){if(!a(t.user,o.UPDATE_TRANSACTION))throw new n;let c=t.db.queryOne(M,[r]);if(!c)throw new e(`REQUIRED`);k(t.user,Number(c.group_id));let l=t.db.queryValue(`SELECT receipt_data FROM transactions WHERE id = ?`,[r]),u=A(t,i,l==null?null:String(l));t.db.withTransaction(()=>{t.db.exec(`UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,[u.type,u.amountMinor,u.currency,u.categoryId,u.groupId,u.date,u.notes||null,u.receiptData,new Date().toISOString(),r]),s(t.db,t.user.id,`TRANSACTION_UPDATED`,`transaction`,r,{before:N(c),after:j(u)})})}function R(t,r){if(!a(t.user,o.DELETE_TRANSACTION))throw new n;let i=t.db.queryOne(M,[r]);if(!i)throw new e(`REQUIRED`);k(t.user,Number(i.group_id)),t.db.withTransaction(()=>{s(t.db,t.user.id,`TRANSACTION_DELETED`,`transaction`,r,{...N(i),userId:i.user_id}),t.db.exec(`DELETE FROM transactions WHERE id = ?`,[r])})}function z(t,n){let r=C(t);if(n==null)return r;if(!Number.isSafeInteger(n)||n<=0)throw new e(`GROUP`);return k(t,n),{sql:`(${r.sql}) AND t.group_id = ?`,params:[...r.params,n]}}function B(e,t,r,s=null){if(!a(e.user,o.READ_DASHBOARD))throw new n;let c=z(e.user,s),u=e.currency,f=e.db.queryOne(`SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${c.sql}`,[t.start,t.end,u,...c.params]),p=Number(f?.income??0),m=Number(f?.expense??0),h=e.db.query(`SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${c.sql}
     GROUP BY month, t.type
     ORDER BY month`,[t.start,t.end,u,...c.params]),g=d(t.start,t.end),_=g.map(e=>{let t=h.find(t=>t.month===e&&t.type===`INCOME`);return Number(t?.total??0)}),v=g.map(e=>{let t=h.find(t=>t.month===e&&t.type===`EXPENSE`);return Number(t?.total??0)}),y=r===`uz-Latn`?`c.name_uz_latn`:r===`uz-Cyrl`?`c.name_uz_cyrl`:r===`ru`?`c.name_ru`:`c.name_en`,b=e.db.query(`SELECT ${y} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${c.sql}
       GROUP BY c.id
       ORDER BY total DESC`,[t.start,t.end,u,...c.params]).map(e=>({label:String(e.label),total:Number(e.total)})),x=e.db.query(`SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${c.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,[t.start,t.end,u,...c.params]).map(e=>({date:String(e.date),total:Number(e.total)})),S=i(e.user)&&s==null?`group`:`user`,C=S===`group`?e.db.query(`SELECT g.name AS label, SUM(t.amount_minor) AS total
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
           ORDER BY total DESC`,[t.start,t.end,u,...c.params]),w=e.db.query(`SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${c.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,[t.start,t.end,u,...c.params]).map(e=>({currency:String(e.currency),income:Number(e.income),expense:Number(e.expense)}));return{income:p,expense:m,net:p-m,savingsRate:p>0?l(p-m,p,1):0,months:g,incomeByMonth:_,expenseByMonth:v,categories:b,trend:x,breakdown:C.map(e=>({label:String(e.label),total:Number(e.total)})),breakdownMode:S,otherCurrencies:w}}export{O as a,C as c,m as d,R as i,L as l,D as n,F as o,I as r,B as s,S as t,h as u};