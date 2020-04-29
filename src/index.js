import Matrix from '@lorena-ssi/matrix-lib'
import Zenroom from '@lorena-ssi/zenroom-lib'
import Credential from '@lorena-ssi/credential-lib'
import LorenaDidResolver from '@lorena-ssi/did-resolver'
import { Resolver } from 'did-resolver'
import { EventEmitter } from 'events'
import log from 'debug'

const debug = log('did:debug:sdk')

/**
 * Lorena SDK - Class
 */
export default class Lorena extends EventEmitter {
  /**
   * @param {object} walletHandler walletHandler
   * @param {object} opts opts
   */
  constructor (walletHandler, opts = {}) {
    super()
    this.opts = opts
    if (opts.debug) debug.enabled = true
    this.zenroom = new Zenroom(opts.silent || false)
    this.wallet = walletHandler
    this.matrix = false
    this.recipeId = 0
    this.queue = []
    this.processing = false
    this.ready = false
    this.nextBatch = ''
    this.disconnecting = false
    this.threadId = 0
    this.resolver = false
  }

  /**
   * First time. Init a wallet.
   *
   * @param {string} network Network the wallet is talking to.
   */
  async initWallet (network) {
    return new Promise((resolve, reject) => {
      const info = LorenaDidResolver.getInfoForNetwork(network)
      if (!info) {
        reject(new Error(`Unknown network ${network}`))
        return
      }
      if (info.symbol) {
        this.wallet.info.symbol = info.symbol
      }
      this.wallet.info.type = info.type
      this.wallet.info.blockchainServer = info.blockchainEndpoint
      this.wallet.info.matrixServer = info.matrixEndpoint
      this.matrix = new Matrix(this.wallet.info.matrixServer)

      this.zenroom.random(12).then((matrixUser) => {
        this.wallet.info.matrixUser = matrixUser.toLowerCase()
        return this.zenroom.random(12)
      }).then((matrixPass) => {
        this.wallet.info.matrixPass = matrixPass
        return this.matrix.available(this.wallet.info.matrixUser)
      }).then((available) => {
        if (available) {
          return this.matrix.register(this.wallet.info.matrixUser, this.wallet.info.matrixPass)
        } else {
          reject(new Error('Could not init wallet'))
        }
      }).then(() => {
        resolve(this.wallet.info)
      }).catch(() => {
        reject(new Error('Could not init wallet'))
      })
    })
  }

  /**
   * Locks (saves and encrypts) the wallet
   *
   * @param {string} password Wallet password
   * @returns {boolean} success
   */
  async lock (password) {
    const result = await this.wallet.lock(password)
    if (result) {
      this.emit('locked', password)
    }
    return result
  }

  /**
   * UnLocks (open and decrypts) the wallet
   *
   * @param {string} password Wallet password
   * @returns {boolean} success
   */
  async unlock (password) {
    const result = await this.wallet.unlock(password)
    if (result) {
      this.emit('unlocked', password)
    }
    return result
  }

  /**
   * saves a Schema.org valid Person
   *
   * @param {object} person Owner of the wallet (Person).
   */
  personalData (person) {
    this.wallet.info.person = person.subject
  }

  async signCredential (subject) {
    return new Promise((resolve) => {
      // Sign the persona
      Credential.signCredential(this.zenroom, subject, this.wallet.info.keyPair, this.wallet.info.did)
        .then((signCredential) => {
          this.wallet.add('credentials', {
            type: 'Persona',
            issuer: this.wallet.info.did,
            id: this.wallet.info.did,
            credential: signCredential
          })
          this.emit('change')
          resolve(signCredential)
        })
    })
  }

  getContact (roomId) {
    return this.wallet.get('links', { roomId: roomId })
  }

  /**
   * Connect to Lorena IDspace.
   *
   * @returns {boolean} success (or errors thrown)
   */
  async connect () {
    if (this.ready === true) return true
    else if (this.wallet.info.matrixUser) {
      try {
        // Connect to Matrix.
        this.matrix = new Matrix(this.wallet.info.matrixServer)
        await this.matrix.connect(this.wallet.info.matrixUser, this.wallet.info.matrixPass)

        // Ready to use events.
        const events = await this.matrix.events('')
        this.nextBatch = events.nextBatch
        this.ready = true
        this.processQueue()
        this.emit('ready')

        this.loop()
        return true
      } catch (error) {
        debug('%O', error)
        this.emit('error', error)
        throw error
      }
    }
  }

  /**
   * Disconnect for clean shutdown
   */
  disconnect () {
    this.emit('disconnecting')
    this.disconnecting = true
  }

  /**
   * Loop through received messages.
   */
  async loop () {
    let parsedElement
    while (!this.disconnecting) {
      const events = await this.getMessages()
      this.processQueue()
      events.forEach(async (element) => {
        try {
          switch (element.type) {
            case 'contact-incoming':
              // add(collection, value)
              this.wallet.add('links', {
                roomId: element.roomId,
                alias: '',
                did: '',
                matrixUser: element.sender,
                status: 'incoming'
              })
              await this.matrix.acceptConnection(element.roomId)
              this.emit('contact-incoming', element.sender)
              this.emit('change')
              break
            case 'contact-add':
              // update(collection, where, value) value can be partial
              this.wallet.update('links', { roomId: element.roomId }, {
                status: 'connected'
              })
              // await this.matrix.acceptConnection(element.roomId)
              this.emit('link-added', element.sender)
              this.emit('change')
              break
            default:
              parsedElement = JSON.parse(element.payload.body)
              parsedElement.roomId = element.roomId
              debug(`loop element.roomId: ${element.roomId}`)
              this.emit(`message:${parsedElement.recipe}`, parsedElement)
              this.emit('message', parsedElement)
              break
          }
        } catch (error) {
          debug('%O', error)
          this.emit('warning', 'element unknown')
        }
      })
    }
  }

  /**
   * get All messages
   *
   * @returns {*} events
   */
  async getMessages () {
    try {
      const result = await this.matrix.events(this.nextBatch)
      this.nextBatch = result.nextBatch
      return (result.events)
    } catch (e) {
      // If there was an error, log it and return empty events for continuation
      debug(e)
      return []
    }
  }

  /**
   * process Outgoing queue of messages
   */
  async processQueue () {
    try {
      if (this.queue.length > 0) {
        const sendPayload = JSON.stringify(this.queue.pop())
        await this.matrix.sendMessage(this.wallet.info.roomId, 'm.action', sendPayload)
      }
      if (this.queue.length === 0) {
        this.processing = false
      }
    } catch (e) {
      debug(e)
    }
  }

  /**
   * Waits for something to happen only once
   *
   * @param {string} msg Message to be listened to
   * @param {number} timeout for the call
   * @returns {Promise} Promise with the result
   */
  oneMsg (msg, timeout = 10000) {
    return Promise.race(
      [
        new Promise((resolve) => {
          this.once(msg, (data) => {
            resolve(data)
          })
        }),
        new Promise((resolve) => setTimeout(() => resolve(false), timeout))
      ]
    )
  }

  /**
   * Sends an action to another DID
   *
   * @param {string} recipe Remote recipe name
   * @param {number} recipeId Remote recipe Id
   * @param {string} threadRef Local Recipe name
   * @param {number} threadId Local recipe Id
   * @param {object} payload Information to send
   * @param {string} roomId Contact to send recipe to
   */
  async sendAction (recipe, recipeId, threadRef, threadId, payload, roomId = false) {
    const action = {
      recipe,
      recipeId,
      threadRef,
      threadId,
      payload
    }
    if (!this.processing && this.ready) { // execute just in time
      this.processing = true
      const sendPayload = JSON.stringify(action)
      const sendTo = (roomId === false) ? this.wallet.info.roomId : roomId
      await this.matrix.sendMessage(sendTo, 'm.action', sendPayload)
    } else {
      this.queue.push(action)
    }
    return this.recipeId
  }

  /**
   * Call a recipe, using the intrinsic threadId adn get back the single message
   *
   * @param {string} recipe name
   * @param {*} payload to send with recipe
   * @param {string} roomId room ID
   * @param {number=} threadId thread ID (if not provided use intrinsic thread ID management)
   * @returns {Promise} of message returned
   */
  async callRecipe (recipe, payload = {}, roomId, threadId = undefined) {
    // use the threadId if provided, otherwise use the common one
    if (threadId === undefined || threadId === 0) {
      threadId = this.threadId++
    }
    await this.sendAction(recipe, 0, recipe, threadId, payload, roomId)
    return this.oneMsg(`message:${recipe}`)
  }

  async getDiddoc (did) {
    if (!this.resolver) {
      const lorResolver = LorenaDidResolver.getResolver()
      this.resolver = new Resolver(lorResolver, true)
    }
    const diddoc = await this.resolver.resolve(did)
    return diddoc
  }

  async getMatrixUserIDForDID (did) {
    const diddoc = await this.getDiddoc(did)
    const matrixUserID = diddoc.service[0].serviceEndpoint
    return matrixUserID
  }

  async getPublicKeyForDID (did) {
    const diddoc = await this.getDiddoc(did)
    const publicKey = diddoc.authentication[0].publicKey
    return publicKey
  }

  /**
   * Open Connection with another user.
   *
   * @param {string} did DID
   * @param {string} matrixUserID Matrix user ID in format @username:home.server.xxx
   * @returns {Promise} Room ID created, or false
   */
  async createConnection (did, matrixUserID) {
    if (matrixUserID === undefined) {
      matrixUserID = await this.getMatrixUserIDForDID(did)
    }

    const link = {
      did: false,
      linkDid: did,
      roomId: '',
      roomName: await this.zenroom.random(12),
      keyPair: false,
      matrixUser: matrixUserID,
      status: 'invited',
      alias: ''
    }
    return new Promise((resolve, reject) => {
      this.matrix.createConnection(link.roomName, matrixUserID)
        .then((roomId) => {
          link.roomId = roomId
          this.wallet.add('links', link)
          this.emit('change')
          resolve(roomId)
        })
        .catch((e) => {
          debug(`createConnection ${e}`)
          resolve(false)
        })
    })
  }

  /**
   * memberOf
   *
   * @param {string} roomId Contact Identifier
   * @param {string} extra Extra information
   * @param {string} roleName Name fo the role we ask for
   * @returns {Promise} Result of calling recipe member-of
   */
  async memberOf (roomId, extra, roleName) {
    return new Promise((resolve, reject) => {
      let challenge = ''
      let link = {}
      this.zenroom.random(32)
        .then((result) => {
          challenge = result
          return this.wallet.get('links', { roomId: roomId })
        })
        .then((result) => {
          if (!result) {
            debug(`did:debug:sdk:memberOf: ${roomId} not found`)
            throw new Error(`memberOf: Room ${roomId} not found`)
          } else {
            link = result
            this.sendAction('member-of', 0, 'member-of', 1, { challenge }, roomId)
              .then(() => {
                return this.oneMsg('message:member-of')
              })
              .then(async (result) => {
                if (result === false) throw (new Error('Timeout'))
                const key = await this.getPublicKeyForDID(link.linkDid)
                if (key === '') {
                  debug(`memberOf: Public key not found for ${link.did}`)
                  throw new Error(`Public key not found for ${link.did}`)
                }
                const pubKey = {}
                pubKey[link.linkDid] = { public_key: key }
                link.did = result.payload.did
                link.keyPair = await this.zenroom.newKeyPair(link.did)
                const check = await this.zenroom.checkSignature(link.linkDid, pubKey, result.payload.signature, link.did)
                if (check.signature === 'correct') {
                  const person = new Credential.Person(this.wallet.info.person)
                  person.subject.did = link.did
                  const signedCredential = await Credential.signCredential(this.zenroom, person, link.keyPair, link.did)
                  const payload = {
                    did: link.did,
                    extra,
                    roleName,
                    member: signedCredential,
                    publicKey: link.keyPair[link.did].keypair.public_key
                  }
                  return this.sendAction('member-of', result.threadId, 'member-of', 1, payload, roomId)
                } else {
                  debug(`memberOf: checkSignature result ${check}`)
                  throw new Error(`Signature did not match public key ${key}`)
                }
              })
              .then(async (result) => {
                return this.oneMsg('message:member-of')
              })
              .then(async (result) => {
                this.wallet.update('links', { roomId: roomId }, {
                  status: 'requested',
                  did: link.did,
                  keyPair: link.keyPair
                })
                this.emit('change')
                resolve(result.payload.msg)
              })
              .catch((e) => {
                reject(e)
              })
          }
        }).catch((e) => {
          reject(e)
        })
    })
  }

  /**
   * memberOfConfirm.
   *
   * @param {string} roomId Contact Identifier
   * @param {string} secretCode secret Code
   */
  async memberOfConfirm (roomId, secretCode) {
    return new Promise((resolve, reject) => {
      const room = this.wallet.get('links', { roomId: roomId })
      if (!room) {
        debug(`memberOfConfirm: room ${roomId} is not in links`)
        resolve(false)
      } else {
        this.sendAction('member-of-confirm', 0, 'member-of-confirm', 1, { secretCode }, roomId)
          .then(() => {
            return this.oneMsg('message:member-of-confirm')
          })
          .then(async (result) => {
            if (result === false) throw (new Error('Timeout'))
            if (result.payload.msg === 'member verified') {
              this.wallet.update('links', { roomId: roomId }, { status: 'verified' })
              this.wallet.add('credentials', result.payload.credential)
              this.emit('change')
              resolve(result.payload.msg)
            } else {
              resolve(result.payload.msg)
            }
          })
          .catch((e) => {
            reject(e)
          })
      }
    })
  }

  /**
   * Ask to a link for a credential.
   *
   * @param {string} roomId Contact identifier
   * @param {string} credentialType Credential we ask for.
   * @param {number=} threadId thread ID (if not provided use intrinsic thread ID management)
   * @returns {boolean} result
   */
  async askCredential (roomId, credentialType, threadId = undefined) {
    // use the threadId if provided, otherwise use the common one
    if (threadId === undefined) {
      threadId = this.threadId++
    }
    return new Promise((resolve) => {
      const payload = {
        credentialType: credentialType
      }
      this.sendAction('credential-get', 0, 'credential-ask', threadId, payload, roomId)
        .then(() => {
          resolve(true)
        })
    })
  }

  /**
   * Delete a link and leave the room for that link.
   *
   * @param {string} roomId Contact to be removed
   */
  async deleteLink (roomId) {
    return new Promise((resolve) => {
      this.matrix.leaveRoom(roomId)
        .then((roomId) => {
          this.wallet.add('links', {
            roomId,
            alias: '',
            did: '',
            matrixUser: '',
            status: 'invited'
          })
          this.emit('change')
          resolve(true)
        }).catch((_e) => {
          resolve(false)
        })
    })
  }

  validateCertificate (json) {
    return new Promise((resolve) => {
      try {
        // const verified = {}
        const credential = JSON.parse(json)
        console.log(credential)

        // Get issuer
        // verified.issuer = did

        // get Publick Key -> Resolve from Blockchain
        // verified.network =
        // verified.pubKey =
        // verified.checkIssuer =

        // Verify Signature -> The certificate is signed by the Issuer
        // verified.checkCertificateSignature =

        // IPFS DAG : Load Credential
        // verified.credential =

        // Verify Credencial -> The credential is signed by the Issuer
        // verified.checkCredentialSignature =

        // const valid = verified.checkIssuer && verified.checkCertificateSignature && verified.checkCredentialSignature
        const valid = false
        resolve({ success: valid })
      } catch (error) {
        resolve(false)
      }
    })
  }

  /**
   * Overrides `on` from EventEmitter to dispatch ready if this.ready.
   *
   * @param {string} event Event name
   * @param {Function} cb Callback function
   * @returns {void}
   */
  on (event, cb) {
    if (event === 'ready' && this.ready) return cb()
    return super.on(event, cb)
  }
}
