'use strict'
/**
 * Máquina de estados de una reserva (Core Booking Engine).
 *
 * Define los estados base y las transiciones válidas. Cada vertical puede añadir
 * SUB-estados (vertical_status) sobre CONFIRMED sin tocar esta tabla:
 *   medical:     arrived → in_consultation → completed
 *   restaurant:  seated → dining → finished (+ waitlist)
 *   hotel:       checked_in (in_house) → checked_out (+ early/late)
 *   cinema:      paid → used
 *
 * Nota: el panel humano puede forzar estados (override), por eso la validación
 * estricta solo se aplica donde la lógica lo necesita. `canTransition` y
 * `nextStates` se exponen para guiar a la IA y a futuras fases.
 */

const STATES = ['pending', 'confirmed', 'rescheduled', 'cancelled', 'noshow', 'completed']

// 'noshow' no es terminal: puede reagendarse (ver TRANSITIONS).
const TERMINAL = new Set(['cancelled', 'completed'])

// from -> [to permitidos] (camino "feliz" + correcciones razonables)
const TRANSITIONS = {
  pending:     ['confirmed', 'rescheduled', 'cancelled', 'noshow', 'completed'],
  confirmed:   ['rescheduled', 'cancelled', 'noshow', 'completed'],
  rescheduled: ['confirmed', 'rescheduled', 'cancelled', 'noshow', 'completed'],
  cancelled:   [],            // terminal
  noshow:      ['rescheduled'], // un no-show puede reagendarse
  completed:   [],            // terminal
}

function isValidState(s) { return STATES.includes(s) }
function isTerminal(s) { return TERMINAL.has(s) }
function nextStates(from) { return TRANSITIONS[from] || [] }
function canTransition(from, to) {
  if (!isValidState(to)) return false
  if (!from) return true                 // creación
  if (from === to) return true           // idempotente
  return (TRANSITIONS[from] || []).includes(to)
}

module.exports = { STATES, TERMINAL, TRANSITIONS, isValidState, isTerminal, nextStates, canTransition }
