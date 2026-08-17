'use strict'
/**
 * Cuántos productos ve el asistente cuando pregunta por una categoría.
 *
 *   node pruebas/busqueda-productos.test.js
 *
 * Preguntar «¿qué cosas dulces tienen?» traía OCHO por muchos dulces que hubiera, y el asistente
 * los presentaba como si fueran el catálogo entero. Parecía la búsqueda semántica flojeando y
 * era un tope: `limit = 8` en searchVector y, encima, otro `.slice(0, 8)` en la herramienta.
 */
const path = require('path')
const Module = require('module')

const DULCES = [
  'Brownie de chocolate', 'Alfajor de maicena', 'Torta de zanahoria', 'Cheesecake de fresa',
  'Galleta de avena', 'Flan de caramelo', 'Mousse de maracuyá', 'Tiramisú', 'Donut glaseada',
  'Cupcake de vainilla', 'Helado de pistacho', 'Tarta de manzana', 'Profiterol', 'Macarons',
  'Panna cotta', 'Arroz con leche', 'Natilla', 'Merengue', 'Trufa de chocolate', 'Crepe de nutella',
  'Milhojas', 'Éclair de café', 'Budín de pan', 'Gelatina de mora', 'Waffle con miel',
]
const SALADOS = ['Empanada de carne', 'Sándwich de pollo', 'Ensalada césar']

// Filas del índice: el embedding se finge con un vector que separa dulce de salado.
const filas = [
  ...DULCES.map(nombre => ({ nombre, dulce: true })),
  ...SALADOS.map(nombre => ({ nombre, dulce: false })),
].map(({ nombre, dulce }) => ({
  content: nombre,
  embedding: JSON.stringify(dulce ? [1, 0] : [0, 1]),
  product_json: JSON.stringify({ id: nombre, name: nombre, price: '10.000', description: nombre }),
}))

const raiz = path.resolve(__dirname, '..')
const dobles = {
  [path.join(raiz, 'db.js')]: {
    async query(sql) {
      if (/FROM product_index/i.test(sql)) return [filas]
      // Sin clave, searchVector se rinde y devuelve null antes de buscar nada.
      if (/openai_key FROM accounts/i.test(sql)) return [[{ openai_key: 'sk-prueba' }]]
      if (/FROM platform_settings/i.test(sql)) return [[{ openai_key: 'sk-prueba' }]]
      return [[]]
    },
  },
  // `loadCtx` de una tienda mira la config de WooCommerce; aquí solo hace falta la plataforma.
  [path.join(raiz, 'services', 'store.js')]: {
    loadConfig: async () => ({ platform: 'woocommerce' }),
    publicConfig: () => ({ connected: true }),
    saveConfig: async () => {},
    searchProducts: async () => [],
  },
  // Solo se finge el EMBEDDING: la consulta «dulce» apunta al mismo lado que los postres
  // (coseno 1 con ellos, 0 con lo salado). El cálculo de similitud es el de verdad, que es
  // parte de lo que se está probando.
  [path.join(raiz, 'services', 'rag.js')]: { ...require('../services/rag'), getEmbedding: async () => [1, 0] },
}
const cargarOriginal = Module._load
Module._load = function (pedido, padre, esPrincipal) {
  const resuelto = (() => { try { return Module._resolveFilename(pedido, padre) } catch { return null } })()
  if (resuelto && dobles[resuelto]) return dobles[resuelto]
  return cargarOriginal.call(this, pedido, padre, esPrincipal)
}

const idx = require('../services/productIndex')

let fallos = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fallos++ }

;(async () => {
  console.log('\n· «cosas dulces» sobre un catálogo con 25 dulces y 3 salados')

  const r = await idx.searchVectorDetalle('acc1', 'cosas dulces', { source: 'store' })
  if (!r) {
    console.log('  ✗ la búsqueda no se pudo ejecutar (¿faltó algún doble?)')
    process.exit(1)
  }

  ok(r.total === DULCES.length, `encuentra los ${DULCES.length} dulces (encontró ${r.total})`)
  ok(r.productos.length > 8, `devuelve MÁS de 8 (devolvió ${r.productos.length}) — era el tope viejo`)
  ok(r.productos.length === Math.min(idx.LIMITE_POR_DEFECTO, DULCES.length),
    `devuelve hasta el tope nuevo (${idx.LIMITE_POR_DEFECTO})`)
  ok(r.recortado === true, 'y avisa de que se recortó, para que el asistente lo diga')
  ok(!r.productos.some(p => SALADOS.includes(p.name)), 'no cuela nada salado')

  console.log('\n· Con un tope explícito se respeta')
  const r2 = await idx.searchVectorDetalle('acc1', 'cosas dulces', { source: 'store', limit: 5 })
  ok(r2.productos.length === 5, `pide 5 y devuelve 5 (devolvió ${r2.productos.length})`)
  ok(r2.total === DULCES.length, 'pero el total sigue siendo el real')
  ok(r2.recortado === true, 'y se marca como recortado')

  console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${fallos} comprobación(es) fallida(s)\n`)
  process.exit(fallos ? 1 : 0)
})()
