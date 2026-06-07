'use strict'
const pool   = require('../db')
const socket = require('../services/socket')
const { uid, parseJ } = require('../utils')

const createPipeline = async (req, res) => {
  const { accId } = req.params
  const { name, stages = [], cards = [] } = req.body
  const id = 'pipe_' + uid()
  try {
    await pool.query('INSERT INTO pipelines (id,account_id,name,stages,cards) VALUES (?,?,?,?,?)', [id, accId, name, JSON.stringify(stages), JSON.stringify(cards)])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ id })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

const updatePipeline = async (req, res) => {
  const { accId, pipeId } = req.params
  const { name, stages, cards, addStage, deleteStage, addCard, updateCard, deleteCard, moveCard } = req.body
  try {
    if (addStage || deleteStage || addCard || updateCard || deleteCard || moveCard) {
      const [[pipe]] = await pool.query('SELECT * FROM pipelines WHERE id=? AND account_id=?', [pipeId, accId])
      if (!pipe) return res.status(404).json({ error: 'Pipeline no encontrado' })
      let pStages = parseJ(pipe.stages, [])
      let pCards  = parseJ(pipe.cards, [])
      if (addStage)    pStages.push(addStage)
      if (deleteStage) { pStages = pStages.filter(s => s.id !== deleteStage); pCards = pCards.map(c => c.stageId === deleteStage ? { ...c, stageId: null } : c) }
      if (addCard)     pCards.push({ id: 'card_' + uid(), ...addCard })
      if (updateCard)  pCards = pCards.map(c => c.id === updateCard.id ? { ...c, ...updateCard } : c)
      if (deleteCard)  pCards = pCards.filter(c => c.id !== deleteCard)
      if (moveCard)    pCards = pCards.map(c => c.id === moveCard.cardId ? { ...c, stageId: moveCard.toStageId } : c)
      await pool.query('UPDATE pipelines SET stages=?,cards=? WHERE id=?', [JSON.stringify(pStages), JSON.stringify(pCards), pipeId])
      socket.emit(accId, 'account:updated', { accId })
      return res.json({ ok: true })
    }
    const sets = []; const vals = []
    if (name   !== undefined) { sets.push('name=?');   vals.push(name) }
    if (stages !== undefined) { sets.push('stages=?'); vals.push(JSON.stringify(stages)) }
    if (cards  !== undefined) { sets.push('cards=?');  vals.push(JSON.stringify(cards)) }
    if (!sets.length) return res.json({ ok: true })
    vals.push(pipeId, accId)
    await pool.query(`UPDATE pipelines SET ${sets.join(',')} WHERE id=? AND account_id=?`, vals)
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { console.error('[PUT PIPE]', err); res.status(500).json({ error: 'Error interno' }) }
}

const deletePipeline = async (req, res) => {
  const { accId, pipeId } = req.params
  try {
    await pool.query('DELETE FROM pipelines WHERE id=? AND account_id=?', [pipeId, accId])
    socket.emit(accId, 'account:updated', { accId })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'Error interno' }) }
}

module.exports = { createPipeline, updatePipeline, deletePipeline }
