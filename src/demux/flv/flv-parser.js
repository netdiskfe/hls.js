/**
 * @file:   flv-parser.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-07 15:06:41
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-07 16:03:45
 */

class FLVParser {

    constructor (data) {
        this.hasAudioTags = true;
        this.hasVideoTags = true;
        this.bodyOffset = 0;
        if (data) {
            this.readFileHeader(data);
        }
    }

    readFileHeader (data) {
        if (data.length < FLVParser.MIN_FILE_HEADER_BYTE_COUNT) {
            throw new Error('data too short');
        }
            
        if (data[0] !== 0x46) {
            throw new Error('FLVHeader Signature[0] not "F"');
        }

        if (data[1] !== 0x4C) {
            throw new Error('FLVHeader Signature[1] not "L"');
        }

        if (data[2] !== 0x56) {
            throw new Error('FLVHeader Signature[2] not "V"');
        }
        
        if (data[3] !== 0x01) {
            throw new Error('FLVHeader Version not 0x01');
        }

        var flags = data[4];
        this.hasAudioTags = (flags & 0x04) ? true : false;
        this.hasVideoTags = (flags & 0x01) ? true : false;

        this.bodyOffset = new DataView(data.slice(5).buffer).getUint32(0);
        if (this.bodyOffset < FLVParser.MIN_FILE_HEADER_BYTE_COUNT) {
            throw new Error('FLVHeader bodyOffset smaller than minimum');
        }
    }
}

FLVParser.MIN_FILE_HEADER_BYTE_COUNT = 9;
FLVParser.FILE_HEADER = 'fileHeader';
FLVParser.PREV_TAG = 'prevTag';
FLVParser.HEADER = 'header';
FLVParser.DATA = 'data';

export default FLVParser;