import { nanoid } from 'nanoid'

export default class ApiSocket {
  #id
  #ws
  #auth
  #db
  #uid
  #user
  #subscriptions
  #onClose

  /***
   * @param id Connection ID of this client in the socket connection pool
   * @param ws WebSocket instance of this client
   * @param auth FirebaseAuth instance
   * @param db Firestore instance
   */
  constructor(id, ws, auth, db, onClose) {
    this.#id = id
    this.#ws = ws
    this.#auth = auth
    this.#db = db
    this.#uid = null
    this.#user = null
    this.#subscriptions = new Map()
    this.#onClose = onClose
    this.#init()
  }

  #init() {
    console.log('welcome', this.#id)
    this.#ws.on('message', (message) => this.#handleMessage(message))
    this.#ws.on('close', () => this.#close())
  }

  #verifyToken(token) {
    this.#auth
      .verifyIdToken(token)
      .then(async (decodedToken) => {
        this.#uid = decodedToken.uid
        const doc = await this.#db.collection('users').doc(this.#uid).get()
        this.#user = doc.data()
        this.#setActiveStatus(true)
        this.#emit('verify-success')
      })
      .catch((error) => this.#emit('error', error))
  }

  #parseMessage(message) {
    return JSON.parse(Buffer.from(message).toString('utf8'))
  }

  #handleMessage(message) {
    const request = this.#parseMessage(message)
    if (request.type === 'verify') {
      this.#verifyToken(request.params.token)
    }

    if (this.#uid === null) return // Deter further action if not yet verified

    switch (request.type) {
      case 'subscribe':
        this.#handleSubscribe(request.params)
        break

      case 'unsubscribe':
        this.#unsubscribe(request.params.sid)
        break

      case 'get':
        this.#handleGet(request.params)
        break

      case 'logout':
        this.#logout()
        break
    }
  }

  #newSubscriptionId() {
    let id
    do {
      id = nanoid()
    } while (this.#subscriptions.has(id))
    return id
  }

  #handleSubscribe(params) {
    const sid = this.#newSubscriptionId()
    switch (params.collection) {
      case 'appointments':
        this.#subscribeAppointments(sid)
        break
      case 'chats':
        this.#subscribeChats(sid)
        break

      case 'user':
        this.#subscribeUser(sid, params.uid)
        break
    }
    this.#emit('subscribe-success', {
      ref: params.ref,
      sid: sid,
    })
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "subscribe",
   *    "params": {
   *        "collection": "appointments",
   *        "ref": string?
   *    }
   * }
   * ```
   */
  #subscribeAppointments(subscriptionId) {
    const unsubscribe = this.#db
      .collection('appointments')
      .where(this.#user.user_type, '==', this.#uid)
      .onSnapshot((querySnapshot) => {
        console.log('updated appointments')
        const data = []
        for (let doc of querySnapshot.docs) {
          data.push({
            id: doc.ref.id,
            ...doc.data(),
          })
        }
        this.#emit('appointments', data)
      })
    this.#subscriptions.set(subscriptionId, unsubscribe)
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "subscribe",
   *    "params": {
   *        "collection": "chats",
   *        "ref": string?
   *    }
   * }
   * ```
   */
  #subscribeChats(subscriptionId) {
    const unsubscribe = this.#db
      .collection('chats')
      .where(this.#user.user_type, '==', this.#uid)
      .onSnapshot((querySnapshot) => {
        console.log('updated chats')
        const data = []
        for (let doc of querySnapshot.docs) {
          data.push({
            id: doc.ref.id,
            ...doc.data(),
          })
        }
        this.#emit('chats', data)
      })
    this.#subscriptions.set(subscriptionId, unsubscribe)
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "subscribe",
   *    "params": {
   *        "collection": "user",
   *        "ref": string?,
   *        "uid": string
   *    }
   * }
   * ```
   */
  #subscribeUser(subscriptionId, uid) {
    const unsubscribe = this.#db
      .collection('users')
      .doc(uid)
      .onSnapshot((querySnapshot) => {
        console.log('updated user', uid)
        this.#emit('user', {
          uid: uid,
          ...querySnapshot.data()
        })
      })
    this.#subscriptions.set(subscriptionId, unsubscribe)
  }

  async #handleGet(params) {
    let data
    switch (params.collection) {
      case 'appointments':
        data = await this.#getAppointments()
        break

      case 'doctors':
        data = await this.#getDoctors(params.specialty)
        break

      case 'user':
        data = await this.#getUser(params.uid)
        break
    }
    this.#emit('get-success', {
      ref: params.ref,
      content: data,
    })
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "get",
   *    "params": {
   *        "collection": "appointments",
   *        "ref": string?
   *    }
   * }
   * ```
   */
  async #getAppointments() {
    const snapshot = await this.#db
      .collection('appointments')
      .where(this.#user.user_type, '==', this.#uid)
      .get()
    const result = []
    snapshot.forEach((doc) => {
      result.push({
        id: doc.ref.id,
        ...doc.data(),
      })
    })
    return result
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "get",
   *    "params": {
   *        "collection": "doctors",
   *        "ref": string?,
   *        "specialty": string?
   *    }
   * }
   * ```
   */
  async #getDoctors(specialty) {
    let query = await this.#db
      .collection('users')
      .where('user_type', '==', 'doctor')
    if (specialty) {
      query = query.where('specialty', '==', specialty)
    }
    const snapshot = await query.get()
    const result = []
    snapshot.forEach((doc) => {
      result.push({
        uid: doc.ref.id,
        ...doc.data()
      })
    })
    return result
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "get",
   *    "params": {
   *        "collection": "user",
   *        "ref": string?,
   *        "uid": string
   *    }
   * }
   * ```
   */
  async #getUser(uid) {
    const snapshot = await this.#db
      .collection('users')
      .doc(uid)
      .get()
    return snapshot.data()
  }

  #emit(event, data) {
    this.#ws.send(
      JSON.stringify({
        event: event,
        data: data,
      })
    )
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "unsubscribe",
   *    "params": {
   *        "sid": string
   *    }
   * }
   * ```
   */
  #unsubscribe(subscriptionId) {
    if (this.#subscriptions.has(subscriptionId)) {
      this.#subscriptions.get(subscriptionId)()
      this.#subscriptions.delete(subscriptionId)
    }
  }

  #unsubscribeAll() {
    for (let [sid, unsubscribe] of this.#subscriptions) {
      unsubscribe()
    }
  }

  #setActiveStatus(status) {
    this.#db.collection('users').doc(this.#uid).set({
      active: status
    }, { merge: true })
  }

  #close() {
    console.log('bye')
    this.#unsubscribeAll()
    this.#setActiveStatus(false)
    if (this.#onClose) this.#onClose()
  }

  #logout() {
    console.log('logging out', this.#uid)
    this.#setActiveStatus(false)
    this.#unsubscribeAll()
    this.#uid = null
    this.#user = null
    this.#subscriptions = new Map()
  }
}
