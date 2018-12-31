const Logger = require('./logger');
const logger = Logger.new('channel');
const fs = require('fs');
const {signs} = require('./multiSign');
const Channel = require('fabric-client/lib/Channel');
const {sleep} = require('khala-nodeutils/helper');
const FabricUtils = require('fabric-client/lib/utils');
const OrdererUtil = require('./orderer');
exports.setClientContext = (channel, clientContext) => {
	channel._clientContext = clientContext;
};
exports.clearOrderers = (channel) => {
	channel._orderers = new Map();
};
exports.clearPeers = (channel) => {
	channel._channel_peers = new Map();
};
exports.getOrderers = async (channel, healthyOnly) => {
	const orderers = channel.getOrderers();
	if (healthyOnly) {
		const result = [];
		for (const orderer of orderers) {
			try {
				const isAlive = await OrdererUtil.ping(orderer);
				if (isAlive) {
					result.push(orderer);
				}
			} catch (e) {
				return false;
			}
		}
		return result;
	} else {
		return orderers;
	}
};
/**
 * could be ignored from 1.2
 * @author davidliu
 * @param channelName
 * @param toThrow
 * @returns {*}
 */
exports.nameMatcher = (channelName, toThrow) => {
	const namePattern = /^[a-z][a-z0-9.-]*$/;
	const result = channelName.match(namePattern);
	if (!result && toThrow) {
		throw Error(`invalid channel name ${channelName}; should match regx: ${namePattern}`);
	}
	return result;
};
/**
 * @param {Client} client
 * @param {string} channelName
 * @returns {Channel}
 */
exports.new = (client, channelName) => {

	if (!channelName) {
		logger.warn('default to using system channel', exports.genesis);
		channelName = exports.genesis;
	}
	return new Channel(channelName, client);
};
/**
 * This is designed to be along with channel.sendTransaction
 * @param {Client} client
 * @returns {Channel}
 */
exports.newDummy = (client) => {
	return exports.new(client, 'dummy');
};

exports.genesis = 'testchainid';


/**
 *
 * @param {Client[]} signClients
 * @param {Channel} channel
 * @param {string} channelConfigFile file path
 * @param {Orderer} orderer
 * @returns {Promise<T>}
 */
exports.create = async (signClients, channel, channelConfigFile, orderer) => {
	const logger = Logger.new('create-channel');
	const channelName = channel.getName();
	logger.debug({channelName, channelConfigFile});

	const channelClient = channel._clientContext;
	const channelConfig_envelop = fs.readFileSync(channelConfigFile);

	// extract the channel config bytes from the envelope to be signed
	const channelConfig = channelClient.extractChannelConfig(channelConfig_envelop);
	const {signatures} = signs(signClients, channelConfig);
	const txId = channelClient.newTransactionID();
	const request = {
		config: channelConfig,
		signatures,
		name: channelName,
		orderer,
		txId
	};
	logger.debug('signatures', signatures.length);

	// The client application must poll the orderer to discover whether the channel has been created completely or not.
	const results = await channelClient.createChannel(request);
	const {status, info} = results;
	logger.debug('response', {status, info}, results);
	if (status === 'SUCCESS') {
		return results;
	} else {
		if (status === 'SERVICE_UNAVAILABLE' && info === 'will not enqueue, consenter for this channel hasn\'t started yet') {
			logger.warn('loop retry..');
			await sleep(1000);
			return exports.create(signClients, channel, channelConfigFile, orderer);
		} else {
			throw Error(results);
		}
	}
};

/**
 * FIXME: sdk doc WARNING
 * In the case when multiple orderers within single host, meanwhile asLocalhost is true, the orderer names will overlap
 *  (all using localhost:7050). It leads to only one orderer is found in channel.getOrderers after channel.initialize
 * @param channel
 * @param peer
 * @param {boolean} asLocalhost   FIXME:ugly undefined checking in fabric-sdk-node
 * @param TLS
 * @returns {Promise<*|void>}
 */
exports.initialize = async (channel, peer, {asLocalhost, TLS} = {}) => {
	FabricUtils.setConfigSetting('discovery-protocol', TLS ? 'grpcs' : 'grpc');
	return await channel.initialize({target: peer, discover: true, asLocalhost});
};

/**
 * to be atomic, join 1 peer each time
 * @param {Channel} channel
 * @param {Peer} peer
 * @param {Orderer} orderer
 * @param {number} waitTime default 1000, if set to false, will not retry channel join
 * @returns {Promise<*>}
 */
const join = async (channel, peer, orderer, waitTime = 1000) => {
	const logger = Logger.new('join-channel', true);
	logger.debug({channelName: channel.getName(), peer: peer._name});

	const channelClient = channel._clientContext;
	const genesis_block = await channel.getGenesisBlock({orderer});
	const request = {
		targets: [peer],
		txId: channelClient.newTransactionID(),
		block: genesis_block
	};

	const data = await channel.joinChannel(request);
	const joinedBeforeSymptom = 'LedgerID already exists';
	const dataEntry = data[0];

	if (dataEntry instanceof Error) {
		logger.warn(dataEntry);
		const errMessage = dataEntry.message;
		const swallowSymptoms = ['NOT_FOUND', 'UNAVAILABLE', 'Stream removed'];

		if (swallowSymptoms.reduce((result, symptom) => result || errMessage.includes(symptom), false) && waitTime) {
			logger.warn('loopJoinChannel...', errMessage);
			await sleep(waitTime);
			return await join(channel, peer, orderer, waitTime);
		}
		if (errMessage.includes(joinedBeforeSymptom)) {
			// swallow 'joined before' error
			logger.info('peer joined before', peer._name);
			return;
		}
		throw dataEntry;
	}

	const {response: {status, message}} = dataEntry;
	if (status !== 200) {
		throw Error(JSON.stringify({status, message}));
	}
	return dataEntry;

};

exports.join = join;

/**
 * take effect in next block, it is recommended to register a block event after
 * @param channel
 * @param anchorPeerTxFile
 * @param orderer
 * @returns {Promise<BroadcastResponse>}
 */
exports.updateAnchorPeers = async (channel, anchorPeerTxFile, orderer) => {

	const client = channel._clientContext;
	const channelConfig_envelop = fs.readFileSync(anchorPeerTxFile);
	const channelConfig = client.extractChannelConfig(channelConfig_envelop);
	const {signatures} = signs([client], channelConfig);

	const request = {
		config: channelConfig,
		signatures,
		name: channel.getName(),
		orderer,
		txId: client.newTransactionID()
	};

	const result = await client.updateChannel(request);
	if (result.status !== 'SUCCESS') {
		throw Error(JSON.stringify(result));
	}

	logger.info('set anchor peers', result);
	return result;
};
exports.pretty = (channel) => {
	return {
		client: channel._clientContext,
		name: channel._name,
		peers: channel._channel_peers,
		anchorPeers: channel._anchor_peers,
		orderers: channel._orderers,
		kafkas: channel._kafka_brokers
	};
};
