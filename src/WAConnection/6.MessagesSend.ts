import {WAConnection as Base} from './5.User'
import {promises as fs} from 'fs'
import {
    MessageOptions,
    MessageType,
    Mimetype,
    MimetypeMap,
    MediaPathMap,
    WALocationMessage,
    WAContactMessage,
    WATextMessage,
    WAMessageContent, WAMetric, WAFlag, WAMessage, BaileysError, WA_MESSAGE_STATUS_TYPE, WAMessageProto, MediaConnInfo, MessageTypeProto, URL_REGEX, WAUrlInfo, WA_DEFAULT_EPHEMERAL
} from './Constants'
import { generateMessageID, sha256, hmacSign, aesEncrypWithIV, randomBytes, generateThumbnail, getMediaKeys, decodeMediaMessageBuffer, extensionForMediaMessage, whatsappID, unixTimestampSeconds, getAudioDuration  } from './Utils'
import { Mutex } from './Mutex'

export class WAConnection extends Base {
    /**
     * Send a message to the given ID (can be group, single, or broadcast)
     * @param id the id to send to
     * @param message the message can be a buffer, plain string, location message, extended text message
     * @param type type of message
     * @param options Extra options
     */
    async sendMessage(
        id: string,
        message: string | WATextMessage | WALocationMessage | WAContactMessage | Buffer,
        type: MessageType,
        options: MessageOptions = {},
    ) {
        const waMessage = await this.prepareMessage (id, message, type, options)
        await this.relayWAMessage (waMessage, { waitForAck: options.waitForAck !== false })
        return waMessage
    }
    /** Prepares a message for sending via sendWAMessage () */
    async prepareMessage(
        id: string,
        message: string | WATextMessage | WALocationMessage | WAContactMessage | Buffer,
        type: MessageType,
        options: MessageOptions = {},
    ) {
        const content = await this.prepareMessageContent (
            message,
            type,
            options
        )
        const preparedMessage = this.prepareMessageFromContent(id, content, options)
        return preparedMessage
    }
    /**
     * Toggles disappearing messages for the given chat
     * 
     * @param jid the chat to toggle
     * @param ephemeralExpiration 0 to disable, enter any positive number to enable disappearing messages for the specified duration; 
     * For the default see WA_DEFAULT_EPHEMERAL
     */
    async toggleDisappearingMessages(jid: string, ephemeralExpiration?: number, opts: { waitForAck: boolean } = { waitForAck: true }) {
        const message = this.prepareMessageFromContent(
            jid,
            this.prepareDisappearingMessageSettingContent(ephemeralExpiration),
            {}
        )
        await this.relayWAMessage(message, opts)
        return message
    }
    /** Prepares the message content */
    async prepareMessageContent (message: string | WATextMessage | WALocationMessage | WAContactMessage | Buffer, type: MessageType, options: MessageOptions) {
        let m: WAMessageContent = {}
        let message2
        switch (type) {
            case MessageType.text:
            case MessageType.extendedText:
                if (typeof message === 'string') message = {text: message} as WATextMessage
                if ('backgroundArgb' in message) message2 = message
                if ('text' in message) {
                    if (options.detectLinks !== false && message.text.match(URL_REGEX)) {
                        try {
                            console.log(message)
                            message = await this.generateLinkPreview(message.text)
                            if ('backgroundArgb' in message2) {
                                message.textArgb = message2.textArgb
                                message.font = message2.font
                                message.backgroundArgb = message2.backgroundArgb
                            }
                        } catch (error) { // ignore if fails
                            this.logger.trace(`failed to generate link preview for message '${message.text}': ${error}`)
                        }
                    }
                    m.extendedTextMessage = WAMessageProto.ExtendedTextMessage.fromObject(message as any)
                } else {
                    throw new BaileysError ('message needs to be a string or object with property \'text\'', message)
                }
                break
            case MessageType.location:
            case MessageType.liveLocation:
                m.locationMessage = WAMessageProto.LocationMessage.fromObject(message as any)
                break
            case MessageType.contact:
                m.contactMessage = WAMessageProto.ContactMessage.fromObject(message as any)
                break
            case MessageType.image:
            case MessageType.sticker:
            case MessageType.document:
            case MessageType.video:
            case MessageType.audio:
                m = await this.prepareMessageMedia(message as Buffer, type, options)
                break
        }
        return WAMessageProto.Message.fromObject (m)
    }
    prepareDisappearingMessageSettingContent(ephemeralExpiration?: number) {
        ephemeralExpiration = ephemeralExpiration || 0
        const content: WAMessageContent = {
            ephemeralMessage: {
                message: {
                    protocolMessage: {
                        type: WAMessageProto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING,
                        ephemeralExpiration
                    }
                }
            }
        }
        return WAMessageProto.Message.fromObject(content)
    }
    /** Prepare a media message for sending */
    async prepareMessageMedia(buffer: Buffer, mediaType: MessageType, options: MessageOptions = {}) {
        await this.waitForConnection ()

        if (mediaType === MessageType.document && !options.mimetype) {
            throw new Error('mimetype required to send a document')
        }
        if (mediaType === MessageType.sticker && options.caption) {
            throw new Error('cannot send a caption with a sticker')
        }
        if (!options.mimetype) {
            options.mimetype = MimetypeMap[mediaType]
        }
        let isGIF = false
        if (options.mimetype === Mimetype.gif) {
            isGIF = true
            options.mimetype = MimetypeMap[MessageType.video]
        }
        // generate a media key
        const mediaKey = randomBytes(32)
        const mediaKeys = getMediaKeys(mediaKey, mediaType)
        const enc = aesEncrypWithIV(buffer, mediaKeys.cipherKey, mediaKeys.iv)
        const mac = hmacSign(Buffer.concat([mediaKeys.iv, enc]), mediaKeys.macKey).slice(0, 10)
        const body = Buffer.concat([enc, mac]) // body is enc + mac
        const fileSha256 = sha256(buffer)
        const fileEncSha256 = sha256(body)
         // url safe Base64 encode the SHA256 hash of the body
        const fileEncSha256B64 = encodeURIComponent(
                                    fileEncSha256
                                    .toString('base64')
                                    .replace(/\+/g, '-')
                                    .replace(/\//g, '_')
                                    .replace(/\=+$/, '')
                                )
        await generateThumbnail(buffer, mediaType, options)
        if (mediaType === MessageType.audio && !options.duration) {
            try {
                options.duration = await getAudioDuration (buffer)
            } catch (error) {
                this.logger.debug ({ error }, 'failed to obtain audio duration: ' + error.message)
            }
        }

        // send a query JSON to obtain the url & auth token to upload our media
        let json = await this.refreshMediaConn (options.forceNewMediaOptions)

        let mediaUrl: string
        for (let host of json.hosts) {
            const auth = encodeURIComponent(json.auth) // the auth token
            const url = `https://${host.hostname}${MediaPathMap[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`
            
            try {
                const urlFetch = await this.fetchRequest(url, 'POST', body, options.uploadAgent, { 'Content-Type': 'application/octet-stream' })
                const result = await urlFetch.json()
                mediaUrl = result?.url
                
                if (mediaUrl) break
                else {
                    json = await this.refreshMediaConn (true)
                    throw new Error (`upload failed, reason: ${JSON.stringify(result)}`)
                }
            } catch (error) {
                const isLast = host.hostname === json.hosts[json.hosts.length-1].hostname
                this.logger.error (`Error in uploading to ${host.hostname}${isLast ? '' : ', retrying...'}`)
            }
        }
        if (!mediaUrl) throw new Error('Media upload failed on all hosts')

        const message = {
            [mediaType]: MessageTypeProto[mediaType].fromObject (
                {
                    url: mediaUrl,
                    mediaKey: mediaKey,
                    mimetype: options.mimetype,
                    fileEncSha256: fileEncSha256,
                    fileSha256: fileSha256,
                    fileLength: buffer.length,
                    seconds: options.duration,
                    fileName: options.filename || 'file',
                    gifPlayback: isGIF || undefined,
                    caption: options.caption,
                    ptt: options.ptt
                }
            )
        }   
        return WAMessageProto.Message.fromObject(message)// as WAMessageContent
    }
    /** prepares a WAMessage for sending from the given content & options */
    prepareMessageFromContent(id: string, message: WAMessageContent, options: MessageOptions) {
        if (!options.timestamp) options.timestamp = new Date() // set timestamp to now
        if (typeof options.sendEphemeral === 'undefined') options.sendEphemeral = 'chat'
        // prevent an annoying bug (WA doesn't accept sending messages with '@c.us')
        id = whatsappID (id)

        const key = Object.keys(message)[0]
        const timestamp = unixTimestampSeconds(options.timestamp)
        const quoted = options.quoted
        
        if (options.contextInfo) message[key].contextInfo = options.contextInfo

        if (quoted) {
            const participant = quoted.key.fromMe ? this.user.jid : (quoted.participant || quoted.key.participant || quoted.key.remoteJid)

            message[key].contextInfo = message[key].contextInfo || { }
            message[key].contextInfo.participant = participant
            message[key].contextInfo.stanzaId = quoted.key.id
            message[key].contextInfo.quotedMessage = quoted.message
            
            // if a participant is quoted, then it must be a group
            // hence, remoteJid of group must also be entered
            if (quoted.key.participant) {
                message[key].contextInfo.remoteJid = quoted.key.remoteJid
            }
        }
        if (options?.thumbnail) {
            message[key].jpegThumbnail = Buffer.from(options.thumbnail, 'base64')
        }

        const chat = this.chats.get(id)
        if (
            // if we want to send a disappearing message
            ((options?.sendEphemeral === 'chat' && chat?.ephemeral) || 
            options?.sendEphemeral === true) &&
            // and it's not a protocol message -- delete, toggle disappear message
            key !== 'protocolMessage' &&
            // already not converted to disappearing message
            key !== 'ephemeralMessage' 
        ) {
            message[key].contextInfo = {
                ...(message[key].contextInfo || {}),
                expiration: chat?.ephemeral || WA_DEFAULT_EPHEMERAL,
                ephemeralSettingTimestamp: chat?.eph_setting_ts
            }
            message = {
                ephemeralMessage: {
                    message
                }
            }
        } 
        message = WAMessageProto.Message.fromObject (message)

        const messageJSON = {
            key: {
                remoteJid: id,
                fromMe: true,
                id: options?.messageId || generateMessageID(),
            },
            message: message,
            messageTimestamp: timestamp,
            messageStubParameters: [],
            participant: id.includes('@g.us') ? this.user.jid : null,
            status: WA_MESSAGE_STATUS_TYPE.PENDING
        }
        return WAMessageProto.WebMessageInfo.fromObject (messageJSON)
    }
    /** Relay (send) a WAMessage; more advanced functionality to send a built WA Message, you may want to stick with sendMessage() */
    async relayWAMessage(message: WAMessage, { waitForAck } = { waitForAck: true }) {
        const json = ['action', {epoch: this.msgCount.toString(), type: 'relay'}, [['message', null, message]]]
        const flag = message.key.remoteJid === this.user?.jid ? WAFlag.acknowledge : WAFlag.ignore // acknowledge when sending message to oneself
        const mID = message.key.id
        message.status = WA_MESSAGE_STATUS_TYPE.PENDING
        const promise = this.query({
            json, 
            binaryTags: [WAMetric.message, flag], 
            tag: mID, 
            expect200: true,
            requiresPhoneConnection: true
        })
        .then(() => message.status = WA_MESSAGE_STATUS_TYPE.SERVER_ACK)

        if (waitForAck) {
            await promise
        } else {
            promise
            .then(() => this.emit('message-status-update', { ids: [ mID ], to: message.key.remoteJid, type: WA_MESSAGE_STATUS_TYPE.SERVER_ACK }))
            .catch(() => this.emit('message-status-update', { ids: [ mID ], to: message.key.remoteJid, type: WA_MESSAGE_STATUS_TYPE.ERROR }))
        }
        await this.chatAddMessageAppropriate (message)
    }
    /**
     * Fetches the latest url & media key for the given message.
     * You may need to call this when the message is old & the content is deleted off of the WA servers
     * @param message 
     */
    @Mutex (message => message?.key?.id)
    async updateMediaMessage (message: WAMessage) {
        const content = message.message?.audioMessage || message.message?.videoMessage || message.message?.imageMessage || message.message?.stickerMessage || message.message?.documentMessage 
        if (!content) throw new BaileysError (`given message ${message.key.id} is not a media message`, message)
        
        const query = ['query',{type: 'media', index: message.key.id, owner: message.key.fromMe ? 'true' : 'false', jid: message.key.remoteJid, epoch: this.msgCount.toString()},null]
        const response = await this.query ({
            json: query, 
            binaryTags: [WAMetric.queryMedia, WAFlag.ignore], 
            expect200: true, 
            requiresPhoneConnection: true
        })
        Object.keys (response[1]).forEach (key => content[key] = response[1][key]) // update message
    }
    /**
     * Securely downloads the media from the message. 
     * Renews the download url automatically, if necessary.
     */
    @Mutex (message => message?.key?.id)
    async downloadMediaMessage (message: WAMessage) {
        let mContent = message.message?.ephemeralMessage?.message || message.message
        if (!mContent) throw new BaileysError('No message present', { status: 400 })
        
        try {
            const buff = await decodeMediaMessageBuffer (mContent, this.fetchRequest)
            return buff
        } catch (error) {
            if (error instanceof BaileysError && error.status === 404) { // media needs to be updated
                this.logger.info (`updating media of message: ${message.key.id}`)
                await this.updateMediaMessage (message)
                mContent = message.message?.ephemeralMessage?.message || message.message
                const buff = await decodeMediaMessageBuffer (mContent, this.fetchRequest)
                return buff
            }
            throw error
        }
    }
    /**
     * Securely downloads the media from the message and saves to a file. 
     * Renews the download url automatically, if necessary.
     * @param message the media message you want to decode
     * @param filename the name of the file where the media will be saved
     * @param attachExtension should the parsed extension be applied automatically to the file
     */
    async downloadAndSaveMediaMessage (message: WAMessage, filename: string, attachExtension: boolean=true) {
        const buffer = await this.downloadMediaMessage (message)
        const extension = extensionForMediaMessage (message.message)
        const trueFileName = attachExtension ? (filename + '.' + extension) : filename
        await fs.writeFile (trueFileName, buffer)
        return trueFileName
    }
    /** Query a string to check if it has a url, if it does, return required extended text message */
    async generateLinkPreview (text: string) {
        const query = ['query', {type: 'url', url: text, epoch: this.msgCount.toString()}, null]
        const response = await this.query ({json: query, binaryTags: [26, WAFlag.ignore], expect200: true, requiresPhoneConnection: false})

        if (response[1]) response[1].jpegThumbnail = response[2]
        const data = response[1] as WAUrlInfo

        const content = {text} as WATextMessage
        content.canonicalUrl = data['canonical-url']
        content.matchedText = data['matched-text']
        content.jpegThumbnail = data.jpegThumbnail
        content.description = data.description
        content.title = data.title
        content.previewType = 0
        return content
    }
    @Mutex ()
    protected async refreshMediaConn (forceGet = false) {
        if (!this.mediaConn || forceGet || (new Date().getTime()-this.mediaConn.fetchDate.getTime()) > this.mediaConn.ttl*1000) {
            this.mediaConn = await this.getNewMediaConn()
            this.mediaConn.fetchDate = new Date()
        }
        return this.mediaConn
    }
    protected async getNewMediaConn () {
        const {media_conn} = await this.query({json: ['query', 'mediaConn'], requiresPhoneConnection: false})
        return media_conn as MediaConnInfo
    }
}
