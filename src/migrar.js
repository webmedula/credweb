'use strict';

// Roda as migrações e sai. O servidor também migra ao subir; isto é para uso manual.
const { criarPool, migrar } = require('./db');

(async () => {
  const pool = criarPool();
  try {
    const feitas = await migrar(pool);
    console.log(feitas.length ? 'Aplicadas: ' + feitas.join(', ') : 'Banco já está atualizado.');
  } finally {
    await pool.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
