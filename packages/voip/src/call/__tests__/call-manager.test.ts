import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BinaryNode } from 'zapo-js/transport'

import { CallState, EndCallReason, type WaVoipDeps, type WaVoipStores } from '../../types.js'
import { type CallInfo } from '../call-state.js'
import { WaCallManager } from '../WaCallManager.js'

function createMockDeps(): { deps: WaVoipDeps; stores: WaVoipStores; sent: BinaryNode[] } {
    const sent: BinaryNode[] = []
    const deps = {
        authClient: {
            getCurrentCredentials: () => ({
                meJid: '1111111111@lid',
                meLid: '1111111111@lid',
                signedIdentity: undefined
            })
        },
        lowLevelCoordinator: {
            sendNode: async (node: BinaryNode) => {
                sent.push(node)
            },
            query: async () => undefined
        },
        signalProtocol: {
            encryptMessage: async () => ({ type: 'msg', ciphertext: new Uint8Array([1, 2, 3]) }),
            encryptMessagesBatch: async (requests: readonly unknown[]) =>
                requests.map(() => ({ type: 'msg', ciphertext: new Uint8Array([1, 2, 3]) })),
            decryptMessage: async () => new Uint8Array([1, 2, 3])
        },
        signalDeviceSync: {
            syncDeviceList: async () => [{ deviceJids: ['2222222222:0@lid'] }],
            queryLidsByPhoneJids: async () => []
        },
        messageDispatch: {
            syncSignalSession: async () => undefined
        },
        sessionResolver: {
            ensureSessionsBatch: async () => []
        }
    } as unknown as WaVoipDeps
    const stores = {
        privacyToken: { getByJid: async () => undefined }
    } as unknown as WaVoipStores

    return { deps, stores, sent }
}

function buildOfferNode(callId: string, from = '2222222222:0@lid', callerPn?: string): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'OFFERMSGID' },
        content: [
            {
                tag: 'offer',
                attrs: {
                    'call-id': callId,
                    'call-creator': from,
                    ...(callerPn ? { caller_pn: callerPn } : {})
                },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined }
                ]
            }
        ]
    }
}

function buildTerminateNode(
    callId: string,
    from = '2222222222:0@lid',
    reason?: string
): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'TERMINATEMSGID' },
        content: [
            {
                tag: 'terminate',
                attrs: {
                    'call-id': callId,
                    'call-creator': from,
                    ...(reason ? { reason } : {})
                }
            }
        ]
    }
}

function buildAcceptNode(callId: string, from: string, callCreator: string): BinaryNode {
    return {
        tag: 'call',
        attrs: { from, id: 'ACCEPTMSGID' },
        content: [{ tag: 'accept', attrs: { 'call-id': callId, 'call-creator': callCreator } }]
    }
}

function callIdOf(node: BinaryNode): string | undefined {
    const inner = Array.isArray(node.content) ? node.content[0] : null
    return inner && typeof inner === 'object' && 'attrs' in inner
        ? inner.attrs['call-id']
        : undefined
}

test('WaCallManager rejects invalid maxConcurrentCalls', () => {
    const { deps, stores } = createMockDeps()
    assert.throws(
        () => new WaCallManager({ deps, stores, maxConcurrentCalls: 0 }),
        /maxConcurrentCalls must be a positive safe integer/
    )
})

test('startCall blocks when maxConcurrentCalls is reached', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    await manager.startCall({ peerJid: '2222222222@lid' })

    await assert.rejects(
        () => manager.startCall({ peerJid: '3333333333@lid' }),
        /max concurrent calls reached \(1\)/
    )
})

test('startCall allows parallel calls when maxConcurrentCalls > 1', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    const callIdA = await manager.startCall({ peerJid: '2222222222@lid' })
    const callIdB = await manager.startCall({ peerJid: '3333333333@lid' })

    assert.notEqual(callIdA, callIdB)
    assert.equal(manager.getCalls().length, 2)
})

test('incoming offer at capacity is tracked with canAccept false', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    await manager.startCall({ peerJid: '2222222222@lid' })
    const before = sent.length

    const incomingCallId = 'CA11CA11000000000000000000000001'
    await manager.handleCallOffer(buildOfferNode(incomingCallId), '2222222222:0@lid')

    assert.equal(manager.getCalls().length, 2)
    const incoming = manager.getCall(incomingCallId)
    assert.ok(incoming)
    assert.equal(incoming.canAccept, false)
    assert.equal(incoming.isAcceptBlocked, true)

    const rejectNode = sent.slice(before).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'reject'
    })
    assert.equal(rejectNode, undefined)

    const preacceptNode = sent.slice(before).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'preaccept'
    })
    assert.equal(preacceptNode, undefined)

    await assert.rejects(() => manager.acceptCall(incomingCallId), /cannot be accepted/)
})

test('waiting incoming call unblocks when a slot frees', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    const activeCallId = await manager.startCall({ peerJid: '2222222222@lid' })
    const incomingCallId = 'CA11CA11000000000000000000000003'

    await manager.handleCallOffer(buildOfferNode(incomingCallId), '3333333333:0@lid')
    assert.equal(manager.getCall(incomingCallId)!.canAccept, false)

    const beforeEnd = sent.length
    await manager.endCall(activeCallId)

    const incoming = manager.getCall(incomingCallId)
    assert.ok(incoming)
    assert.equal(incoming.canAccept, true)
    assert.equal(incoming.isAcceptBlocked, false)

    const preacceptNode = sent.slice(beforeEnd).find((node) => {
        const inner = Array.isArray(node.content) ? node.content[0] : null
        return inner && typeof inner === 'object' && 'tag' in inner && inner.tag === 'preaccept'
    })
    assert.ok(preacceptNode, 'expected preaccept after slot freed')
})

test('incoming offer with capacity creates a second session', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    await manager.startCall({ peerJid: '2222222222@lid' })

    await manager.handleCallOffer(
        buildOfferNode('CA11CA11000000000000000000000002'),
        '3333333333:0@lid'
    )

    assert.equal(manager.getCalls().length, 2)
})

test('incoming offer preserves the caller phone device jid', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })
    const callerPn = '5511999999999:3@s.whatsapp.net'
    const callId = 'CA11CA110000000000000000000000FE'

    await manager.handleCallOffer(
        buildOfferNode(callId, '2222222222:0@lid', callerPn),
        '2222222222:0@lid'
    )

    assert.equal(manager.getCall(callId)?.callerPn, callerPn)
})

test('handleCallTerminate only ends the matching call', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 2 })

    const callIdA = await manager.startCall({ peerJid: '2222222222@lid' })
    const callIdB = await manager.startCall({ peerJid: '3333333333@lid' })

    await manager.handleCallTerminate(buildTerminateNode(callIdA))

    assert.equal(manager.getCall(callIdA), null)
    assert.ok(manager.getCall(callIdB))
    assert.equal(manager.getCall(callIdB)!.stateData.state, CallState.Ringing)
})

test('an incoming call settled on another device of this account keeps the terminate reason', async () => {
    const cases = [
        ['accepted_elsewhere', EndCallReason.AcceptedElsewhere],
        ['rejected_elsewhere', EndCallReason.RejectedElsewhere],
        [undefined, EndCallReason.UserEnded]
    ] as const
    for (const [reason, expected] of cases) {
        const { deps, stores } = createMockDeps()
        const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })
        const callId = 'CA11CA11000000000000000000000010'
        await manager.handleCallOffer(buildOfferNode(callId), '2222222222:0@lid')
        const call = manager.getCall(callId)
        assert.ok(call)

        await manager.handleCallTerminate(buildTerminateNode(callId, undefined, reason))

        assert.equal(manager.getCall(callId), null)
        assert.equal(call.stateData.endReason, expected, `reason ${reason}`)
    }
})

test('accepted_elsewhere on a call this device placed stays an ordinary hang-up', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })
    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const call = manager.getCall(callId)
    assert.ok(call)

    await manager.handleCallTerminate(
        buildTerminateNode(callId, '2222222222:1@lid', 'accepted_elsewhere'),
        '2222222222:1@lid'
    )

    assert.equal(call.stateData.endReason, EndCallReason.UserEnded)
})

test('an accept on an incoming call ends it as accepted elsewhere and frees its slot', async () => {
    const { deps, stores, sent } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })
    const answeredId = 'CA11CA11000000000000000000000020'
    const waitingId = 'CA11CA11000000000000000000000021'

    await manager.handleCallOffer(buildOfferNode(answeredId), '2222222222:0@lid')
    await manager.handleCallOffer(buildOfferNode(waitingId, '3333333333:0@lid'), '3333333333:0@lid')
    const answered = manager.getCall(answeredId)
    assert.ok(answered)
    assert.equal(manager.getCall(waitingId)!.canAccept, false)

    const before = sent.length
    // Another device of this account (1111111111) picked up the first call.
    await manager.handleCallAccept(
        buildAcceptNode(answeredId, '1111111111:1@lid', '2222222222:0@lid'),
        '1111111111:1@lid'
    )

    assert.equal(manager.getCall(answeredId), null)
    assert.equal(answered.stateData.endReason, EndCallReason.AcceptedElsewhere)
    assert.deepEqual(
        sent.slice(before).filter((node) => callIdOf(node) === answeredId),
        []
    )
    assert.equal(manager.getCall(waitingId)!.canAccept, true)
})

test('call_inbound_audio event includes CallInfo', async () => {
    const { deps, stores } = createMockDeps()
    const manager = new WaCallManager({ deps, stores, maxConcurrentCalls: 1 })

    const callId = await manager.startCall({ peerJid: '2222222222@lid' })
    const call = manager.getCall(callId)
    assert.ok(call)

    let receivedCall: CallInfo | null = null
    manager.on('call_inbound_audio', (info) => {
        receivedCall = info
    })

    manager.emit('call_inbound_audio', call, new Float32Array(960))
    assert.equal(receivedCall, call)
})
