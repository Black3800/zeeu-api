import { Timestamp } from 'firebase-admin/firestore'
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
      case 'fetch':
        this.#fetchUser()
        break

      case 'subscribe':
        this.#handleSubscribe(request.params)
        break

      case 'unsubscribe':
        this.#unsubscribe(request.params.sid)
        break

      case 'get':
        this.#handleGet(request.params)
        break

      case 'post':
        this.#handlePost(request.params)
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

  #verifyToken(token) {
    this.#auth
      .verifyIdToken(token)
      .then(async (decodedToken) => {
        this.#uid = decodedToken.uid
        await this.#fetchUser()
        this.#setActiveStatus(true)
        this.#emit('verify-success')
      })
      .catch((error) => this.#emit('error', error))
  }

  async #fetchUser() {
    console.log('fetching for', this.#uid)
    const doc = await this.#db.collection('users').doc(this.#uid).get()
    this.#user = doc.data()
    this.#emit('fetch-success')
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

      case 'messages':
        this.#subscribeMessages(sid, params.id)
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
   *        "collection": "messages",
   *        "ref": string?,
   *        "id": string
   *    }
   * }
   * ```
   */
  #subscribeMessages(subscriptionId, id) {
    const unsubscribe = this.#db
      .collection('chats')
      .doc(id)
      .collection('messages')
      .orderBy('time')
      .onSnapshot((querySnapshot) => {
        console.log('updated messages')
        const data = []
        for (let doc of querySnapshot.docs) {
          data.push(doc.data())
        }
        this.#emit('messages', {
          id: id,
          content: data,
        })
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
          ...querySnapshot.data(),
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

      case 'chatId':
        data = await this.#getChatIdWithDoctor(params.doctor)
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
   *        "collection": "user",
   *        "ref": string?,
   *        "uid": string
   *    }
   * }
   * ```
   */
  async #getUser(uid) {
    const snapshot = await this.#db.collection('users').doc(uid).get()
    return snapshot.data()
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "get",
   *    "params": {
   *        "collection": "chatId",
   *        "ref": string?,
   *        "doctor": string
   *    }
   * }
   * ```
   */
  async #getChatIdWithDoctor(doctor) {
    const snapshot = await this.#db
      .collection('chats')
      .where('doctor', '==', doctor)
      .where('patient', '==', this.#uid)
      .get()
    if (snapshot.docs.length > 0) {
      return snapshot.docs[0].id
    }
    const chat = await this.#db
      .collection('chats')
      .add({
        doctor: doctor,
        patient: this.#uid,
        latest_message_text: '',
        latest_message_time: Timestamp.now(),
        latest_message_seen_doctor: false,
        latest_message_seen_patient: false
      })
    return chat.id
  }

  async #handlePost(params) {
    switch (params.collection) {
      case 'user':
        await this.#setUser(params.uid, params.user)
        break

      case 'message':
        await this.#setMessage(params.chatId, params.type, params.content)
        break

      case 'seen':
        await this.#seenLatestMessage(params.chatId)
        break

      case 'appointment':
        await this.#setAppointment(params.chatId, params.start, params.end)
        break
    }
    this.#emit('post-success', {
      ref: params.ref,
    })
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "post",
   *    "params": {
   *        "collection": "user",
   *        "ref": string,
   *        "uid": string,
   *        "user": Object
   *    }
   * }
   * ```
   */
  async #setUser(uid, user) {
    console.log('set %s to', uid, user)
    await this.#db.collection('users').doc(uid).set(user)
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "post",
   *    "params": {
   *        "collection": "latest-message",
   *        "ref": string?,
   *        "chatId": string,
   *        "text": string
   *    }
   * }
   * ```
   */
  async #setMessage(chatId, type, content) {
    let latestMessageText;
    const time = Timestamp.now()
    switch (type) {
      case 'text':
        latestMessageText = content
        await this.#setTextMessage(chatId, content, time)
        break

      case 'image':
        latestMessageText = 'Photo'
        await this.#setImageMessage(chatId, content, time)
        break
    }
    await this.#db.collection('chats').doc(chatId).update({
      latest_message_text: latestMessageText,
      latest_message_time: time,
      latest_message_seen_doctor: false,
      latest_message_seen_patient: false
    })
  }

  async #setTextMessage(chatId, text, time) {
    await this.#db.collection('chats').doc(chatId).collection('messages').add({
      type: 'text',
      content: text,
      time: time,
      from_doctor: this.#user.user_type === 'doctor'
    })
  }

  async #setImageMessage(chatId, path, time) {
    await this.#db.collection('chats').doc(chatId).collection('messages').add({
      type: 'image',
      content: path,
      time: time,
      from_doctor: this.#user.user_type === 'doctor'
    })
  }

  async #seenLatestMessage(chatId) {
    if (this.#user.user_type == 'doctor') {
      await this.#db
        .collection('chats')
        .doc(chatId)
        .update({ latest_message_seen_doctor: true })
    } else {
      await this.#db
        .collection('chats')
        .doc(chatId)
        .update({ latest_message_seen_patient: true })
    }
  }

  /***
   * @example
   * ```json
   * {
   *    "type": "post",
   *    "params": {
   *        "collection": "appointment",
   *        "ref": string?,
   *        "chatId": string,
   *        "start": ISO8601,
   *        "end": ISO8601
   *    }
   * }
   * ```
   */
  async #setAppointment(chatId, start, end) {
    const snapshot = await this.#db.collection('chats').doc(chatId).get()
    const chat = snapshot.data()
    const appointment = await this.#db.collection('appointments').add({
      'doctor': chat.doctor,
      'patient': chat.patient,
      'start': Timestamp.fromDate(new Date(start)),
      'end': Timestamp.fromDate(new Date(end))
    })
    const msgTime = Timestamp.now()
    await this.#db.collection('chats').doc(chatId).collection('messages').add({
        from_doctor: true,
        type: 'appointment',
        content: appointment.id,
        time: msgTime
    })
    await this.#db.collection('chats').doc(chatId).update({
      latest_message_text: 'Appointment',
      latest_message_time: msgTime,
      latest_message_seen_doctor: false,
      latest_message_seen_patient: false
    })
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
    if (!this.#uid) return
    this.#db.collection('users').doc(this.#uid).set(
      {
        active: status,
      },
      { merge: true }
    )
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
