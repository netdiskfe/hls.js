/**
 * @file:   flvdemuxer.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-07 10:23:57
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-07 20:45:00
 */

import FLVParser from './flv/flv-parser';
import FLVTag from './flv/flv-tag';
import {logger} from '../utils/logger';

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
        // flush any partial content
        this.aacOverFlow = null;
        this.aacLastPTS = null;
        this.avcNaluState = 0;
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
        this._flvParserState = FLVParser.FILE_HEADER;
        this._duration = duration;

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
                            if (tag.pkt_type === 1) {
                                this._parseAACTag(tag);
                            } else if (tag.pkt_type === 0) {
                                this._aacTrack.config = [41, 145, 136, 0];
                                this._aacTrack.audiosamplerate = 48000;
                                this._aacTrack.channelCount = 2;
                                this._aacTrack.codec = 'mp4a.40.5';
                                this._aacTrack.duration = this._duration; 
                            }
                        } else if (tag.codec === 'avc') {
                            if (tag.pkt_type === 1) {
                                this._parseAVCTag(tag);
                            } else if (tag.pkt_type === 0) {

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

        this.remux(level, sn, null);
    }

    remux (level, sn, data) {
        this.remuxer.remux(level, sn, this._aacTrack, this._avcTrack, this._id3Track, this._txtTrack, this.timeOffset, this.contiguous, data);
    }

    destroy () {
    }

    _parseAACTag (tag) {
        var track = this._aacTrack;
        var pts = 0;
        var aacLastPTS = this.aacLastPTS;
        var frameDuration = 1024 * 90000 / track.audiosamplerate;
        if (aacLastPTS) {
            pts = aacLastPTS + frameDuration;
        } else {
            pts = tag.timestamp * frameDuration;
        }
        track.samples.push({
            dts: pts,
            pts: pts,
            unit: tag.data
        });
        track.len += tag.data.length;
        this.aacLastPTS = pts;
    }

    _parseAVCTag (tag) {
        var track = this._avcTrack;
        var units = this._parseAVCNALu(tag.data);
    }

    _parseAVCNALu (array) {
        var i = 0,
            len = array.byteLength,
            value, overflow, state = this.avcNaluState;
        var units = [],
            unit, unitType, lastUnitStart, lastUnitType;
        while (i < len) {
            value = array[i++];
            // finding 3 or 4-byte start codes (00 00 01 OR 00 00 00 01)
            switch (state) {
                case 0:
                    if (value === 0) {
                        state = 1;
                    }
                    break;
                case 1:
                    if (value === 0) {
                        state = 2;
                    } else {
                        state = 0;
                    }
                    break;
                case 2:
                case 3:
                    if (value === 0) {
                        state = 3;
                    } else if (value === 1 && i < len) {
                        unitType = array[i] & 0x1f;
                        //logger.log('find NALU @ offset:' + i + ',type:' + unitType);
                        if (lastUnitStart) {
                            unit = { data: array.subarray(lastUnitStart, i - state - 1), type: lastUnitType };
                            //logger.log('pushing NALU, type/size:' + unit.type + '/' + unit.data.byteLength);
                            units.push(unit);
                        } else {
                            // lastUnitStart is undefined => this is the first start code found in this PES packet
                            // first check if start code delimiter is overlapping between 2 PES packets,
                            // ie it started in last packet (lastState not zero)
                            // and ended at the beginning of this PES packet (i <= 4 - lastState)
                            let lastState = this.avcNaluState;
                            if (lastState && (i <= 4 - lastState)) {
                                // start delimiter overlapping between PES packets
                                // strip start delimiter bytes from the end of last NAL unit
                                let track = this._avcTrack,
                                    samples = track.samples;
                                if (samples.length) {
                                    let lastavcSample = samples[samples.length - 1],
                                        lastUnits = lastavcSample.units.units,
                                        lastUnit = lastUnits[lastUnits.length - 1];
                                    // check if lastUnit had a state different from zero
                                    if (lastUnit.state) {
                                        // strip last bytes
                                        lastUnit.data = lastUnit.data.subarray(0, lastUnit.data.byteLength - lastState);
                                        lastavcSample.units.length -= lastState;
                                        track.len -= lastState;
                                    }
                                }
                            }
                            // If NAL units are not starting right at the beginning of the PES packet, push preceding data into previous NAL unit.
                            overflow = i - state - 1;
                            if (overflow > 0) {
                                let track = this._avcTrack,
                                    samples = track.samples;
                                //logger.log('first NALU found with overflow:' + overflow);
                                if (samples.length) {
                                    let lastavcSample = samples[samples.length - 1],
                                        lastUnits = lastavcSample.units.units,
                                        lastUnit = lastUnits[lastUnits.length - 1],
                                        tmp = new Uint8Array(lastUnit.data.byteLength + overflow);
                                    tmp.set(lastUnit.data, 0);
                                    tmp.set(array.subarray(0, overflow), lastUnit.data.byteLength);
                                    lastUnit.data = tmp;
                                    lastavcSample.units.length += overflow;
                                    track.len += overflow;
                                }
                            }
                        }
                        lastUnitStart = i;
                        lastUnitType = unitType;
                        state = 0;
                    } else {
                        state = 0;
                    }
                    break;
                default:
                    break;
            }
        }
        if (lastUnitStart) {
            unit = { data: array.subarray(lastUnitStart, len), type: lastUnitType, state: state };
            units.push(unit);
            //logger.log('pushing NALU, type/size/state:' + unit.type + '/' + unit.data.byteLength + '/' + state);
            this.avcNaluState = state;
        }
        return units;
    }

}

export default FLVDemuxer;