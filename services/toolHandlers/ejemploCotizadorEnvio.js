'use strict'
/**
 * EJEMPLO de herramienta con código. Sirve de plantilla para las de verdad.
 *
 * Cotiza un envío a partir del peso y la ciudad. Está resuelto con una tabla local, pero es
 * justo aquí donde una implementación real llamaría a la API de la transportadora, consultaría
 * la base de datos del cliente o haría el cálculo que haga falta.
 *
 * Tres cosas que conviene copiar de aquí:
 *   · los parámetros llevan TIPO, así que el modelo manda un número donde toca,
 *   · se valida igualmente lo que llega —el modelo se equivoca—,
 *   · se devuelve TEXTO pensado para que el asistente lo lea y lo cuente con sus palabras,
 *     no un JSON crudo.
 */

// Tarifa base por ciudad y coste por kilo. Una implementación real lo pediría a su origen.
const TARIFAS = {
  bogota:       { base: 12000, porKilo: 2500 },
  medellin:     { base: 14000, porKilo: 2800 },
  cali:         { base: 14000, porKilo: 2800 },
  barranquilla: { base: 16000, porKilo: 3200 },
}
const normalizar = s => String(s || '')
  .toLowerCase().trim()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // fuera tildes: «Bogotá» → «bogota»

module.exports = {
  clave: 'ejemploCotizadorEnvio',
  nombre: 'Ejemplo · Cotizador de envío',
  descripcion: 'Calcula el costo de un envío por peso y ciudad de destino. Ejemplo para partir de él.',

  parametros: [
    { name: 'ciudad', type: 'enum', required: true,
      values: Object.keys(TARIFAS),
      description: 'Ciudad de destino del envío.' },
    { name: 'peso_kg', type: 'number', required: true,
      description: 'Peso del paquete en kilogramos. Acepta decimales.' },
    { name: 'urgente', type: 'boolean', required: false,
      description: 'Si el cliente pide entrega urgente (recargo del 40 %).' },
  ],

  async ejecutar(ctx, args) {
    const ciudad = normalizar(args?.ciudad)
    const tarifa = TARIFAS[ciudad]
    if (!tarifa) {
      // Decirle al asistente QUÉ hay disponible es lo que evita que se invente una ciudad.
      return `No tengo tarifa para "${args?.ciudad || '(sin ciudad)'}". Las ciudades con cobertura son: ${Object.keys(TARIFAS).join(', ')}.`
    }

    const peso = Number(args?.peso_kg)
    if (!Number.isFinite(peso) || peso <= 0) {
      return 'Necesito el peso del paquete en kilogramos (un número mayor que cero) para poder cotizar.'
    }
    if (peso > 50) {
      return `Un paquete de ${peso} kg supera el máximo de 50 kg por envío. Habría que dividirlo o cotizarlo como carga.`
    }

    const urgente = args?.urgente === true || args?.urgente === 'true'
    const subtotal = tarifa.base + Math.ceil(peso) * tarifa.porKilo
    const total = urgente ? Math.round(subtotal * 1.4) : subtotal
    const pesos = n => '$' + n.toLocaleString('es-CO')

    return [
      `Envío a ${args.ciudad} · ${peso} kg${urgente ? ' · URGENTE' : ''}`,
      `Tarifa base: ${pesos(tarifa.base)}`,
      `Peso (${Math.ceil(peso)} kg × ${pesos(tarifa.porKilo)}): ${pesos(Math.ceil(peso) * tarifa.porKilo)}`,
      urgente ? `Recargo por urgencia: 40 %` : null,
      `TOTAL: ${pesos(total)}`,
      urgente ? 'Entrega en 24 h.' : 'Entrega en 2 a 4 días hábiles.',
    ].filter(Boolean).join('\n')
  },
}
