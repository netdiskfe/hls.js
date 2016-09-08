/**
 * @file:   flvdemuxer.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-07 10:23:57
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-08 22:48:05
 */

import Event from '../events';
import ExpGolomb from './exp-golomb';
import FLVParser from '../demux/flv-parser';
import FLVTag from '../demux/flv-tag';
import {logger} from '../utils/logger';
import {ErrorTypes, ErrorDetails} from '../errors';

class FLVDemuxer {

    constructor (observer, id, remuxerClass, config) {
        this.observer = observer;
        this.id = id;
        this.remuxerClass = remuxerClass;
        this.config = config;
        this.lastCC = 0;
        this.flvParser = new FLVParser();
        this.remuxer = new this.remuxerClass(observer, id, config);
        this._flvParserState = FLVParser.FILE_HEADER;
    }

    static probe (data) {
        // flv starting with 0x46 0x4C 0x56, 0x01
        if (data.length > FLVParser.MIN_FILE_HEADER_BYTE_COUNT && data[0] === 0x46 && data[1] === 0x4C && data[2] === 0x56 && data[3] === 0x01) {
            return true;
        } else {
            return false;
        }
    }

    switchLevel () {
        this._avcTrack = {container : 'video/x-flv', type: 'video', id :-1, sequenceNumber: 0, samples : [], len : 0, nbNalu : 0, dropped : 0};
        this._aacTrack = {container : 'video/x-flv', type: 'audio', id :-1, sequenceNumber: 0, samples : [], len : 0};
        this._id3Track = {type: 'id3', id :-1, sequenceNumber: 0, samples : [], len : 0};
        this._txtTrack = {type: 'text', id: -1, sequenceNumber: 0, samples: [], len: 0};
        this.aacLastPTS = null;
        this.aacDelta = 0;
        this.avcLastPTS = null;
        this.avcDelta = 0;
        this.remuxer.switchLevel();
    }

    insertDiscontinuity () {
        this.switchLevel();
        this.remuxer.insertDiscontinuity();
    }

    // feed incoming data to the front of the parsing pipeline
    push (data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration) {
        var start, len = data.length;
        var cTag = null;

        this.audioCodec = audioCodec;
        this.videoCodec = videoCodec;
        this.timeOffset = timeOffset;
        this.contiguous = false;
        this.aacDelta = 0;
        this.avcDelta = 0;
        this._duration = duration;
        this._flvParserState = FLVParser.FILE_HEADER;

        if (cc !== this.lastCC) {
            logger.log('discontinuity detected');
            this.insertDiscontinuity();
            this.lastCC = cc;
        }
        if (level !== this.lastLevel) {
            logger.log('level switch detected');
            this.switchLevel();
            this.lastLevel = level;
        } else if (sn === (this.lastSN + 1)) {
            this.contiguous = true;
        }
        this.lastSN = sn;

        for (start = 0; start < len; ) {
            switch (this._flvParserState) {
                case FLVParser.FILE_HEADER:
                    this.flvParser.readFileHeader(data.slice(start, start + FLVParser.MIN_FILE_HEADER_BYTE_COUNT));
                    this._flvParserState = FLVParser.PREV_TAG;
                    start += this.flvParser.bodyOffset;
                    break;
                case FLVParser.PREV_TAG:
                    cTag = new FLVTag();
                    this._flvParserState = FLVParser.HEADER;
                    start += FLVTag.PREV_TAG_BYTE_COUNT;
                    break;
                case FLVParser.HEADER:
                    cTag.readHeader(data.slice(start, start + FLVTag.TAG_HEADER_BYTE_COUNT));
                    this._flvParserState = FLVParser.DATA;
                    start += FLVTag.TAG_HEADER_BYTE_COUNT;
                    break;
                case FLVParser.DATA:
                    let tag = cTag.readData(data.slice(start, start + cTag.tagDataSize));
                    if (tag && tag.codec) {
                        if (tag.codec === 'aac') {
                            if (tag.pkt_type === 1 && this._aacTrack.audiosamplerate) {
                                this.parseAACTag(tag);
                            } else if (tag.pkt_type === 0 && !this._aacTrack.audiosamplerate) {
                                this.parseAudioConfig(this.observer, tag.data, 0, audioCodec);
                                this._aacTrack.id = tag.id;
                            }
                        } else if (tag.codec === 'avc') {
                            if (tag.pkt_type === 1 && this._avcTrack.lengthSizeMinusOne) {
                                this.parseAVCTag(tag);
                            } else if (tag.pkt_type === 0 && !this._avcTrack.lengthSizeMinusOne) {
                                this.parseVideoConfig(this.observer, tag.data, 0, audioCodec);
                                this._avcTrack.id = tag.id;
                            }
                        }
                    }
                    this._flvParserState = FLVParser.PREV_TAG;
                    start += cTag.tagDataSize;
                    break;
                default:
                    throw new Error('invalid FLVParserState');
            }
        }

        if (!this.avcFrameDuration) {
            let samples = this._avcTrack.samples;
            if (samples.length) {
                let firstPTS = samples[0].pts;
                let lastPTS = samples[samples.length - 1].pts; 
                this.avcFrameDuration = Math.round((lastPTS - firstPTS) / (samples.length - 1));
            }
        }

        this.remux(level, sn, null);
    }

    remux (level, sn, data) {
        this.remuxer.remux(level, sn, this._aacTrack, this._avcTrack, this._id3Track, this._txtTrack, this.timeOffset, this.contiguous, data);
    }

    destroy () {
    }

    parseAACTag (tag) {
        var track = this._aacTrack;
        var samples = track.samples;
        var pts = Math.round((this.timeOffset * 1000 + tag.timestamp) * 90) - this.aacDelta;
        var aacLastPTS = this.aacLastPTS;
        var frameDuration = 1024 * 90000 / track.audiosamplerate;
        if (aacLastPTS && !this.aacDelta && this.contiguous) {
            let nextPts = aacLastPTS + frameDuration;
            let aacDelta = pts - nextPts;
            if (aacDelta > frameDuration) {
                this.aacDelta = aacDelta;
                pts = nextPts;
            }
        }
        samples.push({
            dts: pts,
            pts: pts,
            unit: tag.data
        });
        track.len += tag.data.byteLength;
        this.aacLastPTS = pts;
    }

    parseAVCTag (tag) {
        var track = this._avcTrack;
        var samples = track.samples,
            units = this.parseAVCNALUnit(tag.data),
            units2 = [],
            debug = false,
            key = false,
            length = 0,
            expGolombDecoder,
            avcSample,
            push,
            i;
        // no NALu found
        if (units.length === 0 && samples.length > 0) {
            // append tag.data to previous NAL unit
            var lastavcSample = samples[samples.length - 1];
            var lastUnit = lastavcSample.units.units[lastavcSample.units.units.length - 1];
            var tmp = new Uint8Array(lastUnit.data.byteLength + tag.data.byteLength);
            tmp.set(lastUnit.data, 0);
            tmp.set(tag.data, lastUnit.data.byteLength);
            lastUnit.data = tmp;
            lastavcSample.units.length += tag.data.byteLength;
            track.len += tag.data.byteLength;
        }
        // free tag.data to save up some memory
        tag.data = null;
        var debugString = '';
        var avcLastPTS = this.avcLastPTS;
        var frameDuration = this.avcFrameDuration;
        var dts = Math.round((this.timeOffset * 1000 + tag.timestamp) * 90) - this.avcDelta;
        var pts = dts + tag.cts * 90;

        if (avcLastPTS && frameDuration && !this.avcDelta && this.contiguous) {
            let nextPts = avcLastPTS + frameDuration;
            let avcDelta = pts - nextPts;
            if (avcDelta > frameDuration) {
                this.avcDelta = avcDelta;
                pts = nextPts;
                dts = pts - tag.cts * 90;
            }
        }

        var pushAccesUnit = function() {
            if (units2.length) {
                // only push AVC sample if starting with a keyframe is not mandatory OR
                //    if keyframe already found in this fragment OR
                //       keyframe found in last fragment (track.sps) AND
                //          samples already appended (we already found a keyframe in this fragment) OR fragment is contiguous
                if (!this.config.forceKeyFrameOnDiscontinuity ||
                    key === true ||
                    (track.sps && (samples.length || this.contiguous))) {
                    avcSample = { units: { units: units2, length: length }, pts: pts, dts: dts, key: key };
                    samples.push(avcSample);
                    track.len += length;
                    track.nbNalu += units2.length;
                } else {
                    // dropped samples, track it
                    track.dropped++;
                }
                units2 = [];
                length = 0;
            }
        }.bind(this);

        units.forEach(unit => {
            switch (unit.type) {
                //NDR
                case 1:
                    push = true;
                    if (debug) {
                        debugString += 'NDR ';
                    }
                    break;
                //IDR
                case 5:
                    push = true;
                    if (debug) {
                        debugString += 'IDR ';
                    }
                    key = true;
                    break;
                //SEI
                case 6:
                    push = true;
                    if (debug) {
                        debugString += 'SEI ';
                    }
                    expGolombDecoder = new ExpGolomb(this.discardEPB(unit.data));

                    // skip frameType
                    expGolombDecoder.readUByte();

                    var payloadType = 0;
                    var payloadSize = 0;
                    var endOfCaptions = false;
                    var b = 0;

                    while (!endOfCaptions && expGolombDecoder.bytesAvailable > 1) {
                        payloadType = 0;
                        do {
                            b = expGolombDecoder.readUByte();
                            payloadType += b;
                        } while (b === 0xFF);

                        // Parse payload size.
                        payloadSize = 0;
                        do {
                            b = expGolombDecoder.readUByte();
                            payloadSize += b;
                        } while (b === 0xFF);

                        // TODO: there can be more than one payload in an SEI packet...
                        // TODO: need to read type and size in a while loop to get them all
                        if (payloadType === 4 && expGolombDecoder.bytesAvailable !== 0) {

                            endOfCaptions = true;

                            var countryCode = expGolombDecoder.readUByte();

                            if (countryCode === 181) {
                                var providerCode = expGolombDecoder.readUShort();

                                if (providerCode === 49) {
                                    var userStructure = expGolombDecoder.readUInt();

                                    if (userStructure === 0x47413934) {
                                        var userDataType = expGolombDecoder.readUByte();

                                        // Raw CEA-608 bytes wrapped in CEA-708 packet
                                        if (userDataType === 3) {
                                            var firstByte = expGolombDecoder.readUByte();
                                            var secondByte = expGolombDecoder.readUByte();

                                            var totalCCs = 31 & firstByte;
                                            var byteArray = [firstByte, secondByte];

                                            for (i = 0; i < totalCCs; i++) {
                                                // 3 bytes per CC
                                                byteArray.push(expGolombDecoder.readUByte());
                                                byteArray.push(expGolombDecoder.readUByte());
                                                byteArray.push(expGolombDecoder.readUByte());
                                            }

                                            this.insertSampleInOrder(this._txtTrack.samples, { type: 3, pts: pts, bytes: byteArray });
                                        }
                                    }
                                }
                            }
                        } else if (payloadSize < expGolombDecoder.bytesAvailable) {
                            for (i = 0; i < payloadSize; i++) {
                                expGolombDecoder.readUByte();
                            }
                        }
                    }
                    break;
                //SPS
                case 7:
                    push = true;
                    if (debug) {
                        debugString += 'SPS ';
                    }
                    if (!track.sps) {
                        expGolombDecoder = new ExpGolomb(unit.data);
                        var config = expGolombDecoder.readSPS();
                        track.width = config.width;
                        track.height = config.height;
                        track.sps = [unit.data];
                        track.duration = this._duration;
                        var codecarray = unit.data.subarray(1, 4);
                        var codecstring = 'avc1.';
                        for (i = 0; i < 3; i++) {
                            var h = codecarray[i].toString(16);
                            if (h.length < 2) {
                                h = '0' + h;
                            }
                            codecstring += h;
                        }
                        track.codec = codecstring;
                    }
                    break;
                //PPS
                case 8:
                    push = true;
                    if (debug) {
                        debugString += 'PPS ';
                    }
                    if (!track.pps) {
                        track.pps = [unit.data];
                    }
                    break;
                case 9:
                    push = false;
                    if (debug) {
                        debugString += 'AUD ';
                    }
                    pushAccesUnit();
                    break;
                default:
                    push = false;
                    debugString += 'unknown NAL ' + unit.type + ' ';
                    break;
            }
            if (push) {
                units2.push(unit);
                length += unit.data.byteLength;
            }
        });
        if (debug || debugString.length) {
            logger.log(debugString);
        }
        pushAccesUnit();
        this.avcLastPTS = pts;
    }

    insertSampleInOrder (arr, data) {
        var len = arr.length;
        if (len > 0) {
            if (data.pts >= arr[len - 1].pts) {
                arr.push(data);
            } else {
                for (var pos = len - 1; pos >= 0; pos--) {
                    if (data.pts < arr[pos].pts) {
                        arr.splice(pos, 0, data);
                        break;
                    }
                }
            }
        } else {
            arr.push(data);
        }
    }

    parseAVCNALUnit (array) {
        var track = this._avcTrack;
        var lengthSizeMinusOne = track.lengthSizeMinusOne;
        var units = [];
        var i = 0;
        var len = array.length;
        while (i < len) {
            let unitLen = 0;
            for (let j = 0; j < lengthSizeMinusOne; j++) {
                unitLen |= array[i + j] << (8 * (lengthSizeMinusOne - 1 - j));
            }
            i += lengthSizeMinusOne;
            let unitType = array[i] & 0x1f;
            units.push({
                type: unitType,
                data: array.slice(i, i + unitLen)
            });
            i += unitLen;
        }
        return units;
    }

    parseAudioConfig (observer, data, offset, audioCodec) {
        var track = this._aacTrack;
        var adtsObjectType, // :int
            adtsSampleingIndex, // :int
            adtsExtensionSampleingIndex, // :int
            adtsChanelConfig, // :int
            config,
            userAgent = navigator.userAgent.toLowerCase(),
            adtsSampleingRates = [
                96000, 88200,
                64000, 48000,
                44100, 32000,
                24000, 22050,
                16000, 12000,
                11025, 8000,
                7350
            ];

        adtsObjectType = (data[0] & 0xF8) >> 3;
        adtsSampleingIndex = ((data[0] & 0x7) << 1) | (data[1] >> 7);
        if (adtsSampleingIndex > adtsSampleingRates.length - 1) {
            observer.trigger(Event.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true, reason: `invalid ADTS sampling index:${adtsSampleingIndex}` });
            return;
        }
        adtsChanelConfig = (data[1] >> 3) & 0x0F;
        logger.log(`manifest codec:${audioCodec},ADTS data:type:${adtsObjectType},sampleingIndex:${adtsSampleingIndex}[${adtsSampleingRates[adtsSampleingIndex]}Hz],channelConfig:${adtsChanelConfig}`);
        // firefox: freq less than 24kHz = AAC SBR (HE-AAC)
        if (userAgent.indexOf('firefox') !== -1) {
            if (adtsSampleingIndex >= 6) {
                adtsObjectType = 5;
                config = new Array(4);
                // HE-AAC uses SBR (Spectral Band Replication) , high frequencies are constructed from low frequencies
                // there is a factor 2 between frame sample rate and output sample rate
                // multiply frequency by 2 (see table below, equivalent to substract 3)
                adtsExtensionSampleingIndex = adtsSampleingIndex - 3;
            } else {
                adtsObjectType = 2;
                config = new Array(2);
                adtsExtensionSampleingIndex = adtsSampleingIndex;
            }
            // Android : always use AAC
        } else if (userAgent.indexOf('android') !== -1) {
            adtsObjectType = 2;
            config = new Array(2);
            adtsExtensionSampleingIndex = adtsSampleingIndex;
        } else {
            /*  for other browsers (chrome ...)
                always force audio type to be HE-AAC SBR, as some browsers do not support audio codec switch properly (like Chrome ...)
            */
            adtsObjectType = 5;
            config = new Array(4);
            // if (manifest codec is HE-AAC or HE-AACv2) OR (manifest codec not specified AND frequency less than 24kHz)
            if ((audioCodec && ((audioCodec.indexOf('mp4a.40.29') !== -1) ||
                    (audioCodec.indexOf('mp4a.40.5') !== -1))) ||
                (!audioCodec && adtsSampleingIndex >= 6)) {
                // HE-AAC uses SBR (Spectral Band Replication) , high frequencies are constructed from low frequencies
                // there is a factor 2 between frame sample rate and output sample rate
                // multiply frequency by 2 (see table below, equivalent to substract 3)
                adtsExtensionSampleingIndex = adtsSampleingIndex - 3;
            } else {
                // if (manifest codec is AAC) AND (frequency less than 24kHz AND nb channel is 1) OR (manifest codec not specified and mono audio)
                // Chrome fails to play back with low frequency AAC LC mono when initialized with HE-AAC.  This is not a problem with stereo.
                if (audioCodec && audioCodec.indexOf('mp4a.40.2') !== -1 && (adtsSampleingIndex >= 6 && adtsChanelConfig === 1) ||
                    (!audioCodec && adtsChanelConfig === 1)) {
                    adtsObjectType = 2;
                    config = new Array(2);
                }
                adtsExtensionSampleingIndex = adtsSampleingIndex;
            }
        }
        // audioObjectType = profile => profile, the MPEG-4 Audio Object Type minus 1
        config[0] = adtsObjectType << 3;
        // samplingFrequencyIndex
        config[0] |= (adtsSampleingIndex & 0x0E) >> 1;
        config[1] |= (adtsSampleingIndex & 0x01) << 7;
        // channelConfiguration
        config[1] |= adtsChanelConfig << 3;
        if (adtsObjectType === 5) {
            // adtsExtensionSampleingIndex
            config[1] |= (adtsExtensionSampleingIndex & 0x0E) >> 1;
            config[2] = (adtsExtensionSampleingIndex & 0x01) << 7;
            // adtsObjectType (force to 2, chrome is checking that object type is less than 5 ???
            //    https://chromium.googlesource.com/chromium/src.git/+/master/media/formats/mp4/aac.cc
            config[2] |= 2 << 2;
            config[3] = 0;
        }
        if (!track.audiosamplerate) {
            track.config = config;
            track.audiosamplerate = adtsSampleingRates[adtsSampleingIndex];
            track.channelCount = adtsChanelConfig;
            track.codec = ('mp4a.40.' + adtsObjectType);
            track.duration = this._duration;
        }
        return {
            config: config,
            samplerate: adtsSampleingRates[adtsSampleingIndex],
            channelCount: adtsChanelConfig,
            codec: ('mp4a.40.' + adtsObjectType)
        };
    }

    parseVideoConfig (observer, data, offset, videoCodec) {
        var track = this._avcTrack;
        var configurationVersion = data[0];
        var AVCProfileIndication = data[1];
        var profile_compatibility = data[2];
        var AVCLevelIndication = data[3];
        var lengthSizeMinusOne = 1 + (data[4] & 3);
        var numOfSequenceParameterSets = data[5] & 0x1F;
        var sidx = 6;
        var sequenceParameterSetLength = new DataView(data.slice(sidx, sidx + 2).buffer).getUint16(0);
        sidx += 2;
        var sequenceParameterSetNALUnits = data.slice(sidx, sidx + sequenceParameterSetLength);
        sidx += sequenceParameterSetLength;
        var numOfPictureParameterSets = data[sidx++];
        var pictureParameterSetLength = new DataView(data.slice(sidx, sidx + 2).buffer).getUint16(0);
        sidx += 2;
        var pictureParameterSetNALUnits = data.slice(sidx, sidx + pictureParameterSetLength);
        if (!track.lengthSizeMinusOne) {
            track.lengthSizeMinusOne = lengthSizeMinusOne;
            var expGolombDecoder = new ExpGolomb(sequenceParameterSetNALUnits);
            var config = expGolombDecoder.readSPS();
            track.width = config.width;
            track.height = config.height;
            track.sps = [sequenceParameterSetNALUnits];
            track.duration = this._duration;
            var codecarray = sequenceParameterSetNALUnits.subarray(1, 4);
            var codecstring = 'avc1.';
            for (var i = 0; i < 3; i++) {
                var h = codecarray[i].toString(16);
                if (h.length < 2) {
                    h = '0' + h;
                }
                codecstring += h;
            }
            track.codec = codecstring;
            track.pps = [pictureParameterSetNALUnits];
        }
        return {
            lengthSizeMinusOne: lengthSizeMinusOne,
            sequenceParameterSetNALUnits: sequenceParameterSetNALUnits,
            pictureParameterSetNALUnits: pictureParameterSetNALUnits
        };
    }

}

export default FLVDemuxer;