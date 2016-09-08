/**
 * @file:   flv-tag.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-07 12:56:09
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-08 16:51:54
 */

class FLVTag {

    constructor (data) {
        this.type = FLVTag.TAG_TYPE_SCRIPTDATAOBJECT;
        this.tagDataSize = 0;
        if (data) {
            this.readHeader(data);
        }
    }

    readPrevTagSize (data) {
        return new DataView(data.buffer).getUint32(0);
    }

    readHeader (data) {
        var type = data[0];
        if (type === FLVTag.TAG_TYPE_AUDIO || type === FLVTag.TAG_TYPE_VIDEO || type === FLVTag.TAG_TYPE_SCRIPTDATAOBJECT) {
            this.type = type;
        } else {
            throw new Error('invalid FLVTagType');
        }

        this.tagDataSize = (data[1] << 16 | data[2] << 8 | data[3]);

        this.timestamp = (data[7] << 24) | (data[4] << 16) | (data[5] << 8) | (data[6]);
    }

    readData (data) {
        switch (this.type) {
            case FLVTag.TAG_TYPE_AUDIO:
                return this.readAudioData(data);
            case FLVTag.TAG_TYPE_VIDEO:
                return this.readVideoData(data);
            case FLVTag.TAG_TYPE_SCRIPTDATAOBJECT:
                break;
            default:
                throw new Error('invalid FLVTagType');
        }
    }

    readAudioData (data) {
        var tag = {
            type: 'audio',
            timestamp: this.timestamp
        };
        var audioHeader = data[0];
        var soundFormat = (audioHeader >> 4) & 0x0f;
        var soundRate = 0;
        switch ((audioHeader >> 2) & 0x03) {
            case 0:
                soundRate = 5512.5;
                break;
            case 1:
                soundRate = 11025;
                break;
            case 2:
                soundRate = 22050;
                break;
            case 3:
                soundRate = 44100;
                break;
            default:
                throw new Error('invalid soundRate');
        }
        // AAC
        if (soundFormat === 10) {
            let packetType = data[1];
            tag.codec = 'aac';
            tag.pkt_type = packetType;
            tag.data = data.slice(2);
            return tag;
        }
    }

    readVideoData (data) {
        var tag = {
            type: 'video',
            timestamp: this.timestamp
        };
        var videoHeader = data[0];
        var codecID = (videoHeader & 0x0f);
        var frameType = (videoHeader >> 4) & 0x0f;
        // AVC 
        if (codecID === 7) {
            let packetType = data[1];
            tag.codec = 'avc';
            tag.key = frameType === 1 ? true : false;
            tag.pkt_type = packetType;
            if (packetType === 1) {
                let compositionTime = data[2] << 16;
                compositionTime |= data[3] << 8;
                compositionTime |= data[4];
                if (compositionTime & 0x00800000) {
                    compositionTime |= 0xff000000;
                }
                tag.cts = compositionTime;
            }
            tag.data = data.slice(5);
            return tag;
        }
    }

}

FLVTag.PREV_TAG_BYTE_COUNT = 4;
FLVTag.TAG_TYPE_AUDIO = 0x08;
FLVTag.TAG_TYPE_VIDEO = 0x09;
FLVTag.TAG_TYPE_SCRIPTDATAOBJECT = 0x12;
FLVTag.TAG_HEADER_BYTE_COUNT = 11;

export default FLVTag;