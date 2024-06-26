import { Injectable } from '@angular/core';
import { SerialService } from '../../serial.service';
import {
  ERASE_BLOCK_SIZE, FwFmtVer, MAX_DATA_LENGTH,
  MIN_PARTITION_SIZE, MSG_CMD_CHANGE_BAUDRATE,
  MSG_CMD_GET_INFO, MSG_CMD_SET_FW_FMT_VER, MSG_CMD_SYS_RST,
  MSG_CMD_UPDATE_BLOCK_WRITE_DONE, MSG_CMD_UPDATE_CHECK_READY,
  MSG_CMD_UPDATE_ERA, MSG_CMD_UPDATE_REQ, MSG_CMD_UPDATE_VERIFY,
  MSG_CMD_UPDATE_VERIFY_INFO, MSG_CMD_UPDATE_WRITE, MSG_TYPE_ACK,
  MSG_TYPE_CMD, OTA_REQUEST_CMD, OTA_RESET_CMD, OTA_UPDATER_BAUDRATE,
  PARTITION_INVALID_FILE_MASK, PARTITION_TABLE1_START_ADDR,
  PARTITION_TABLE2_START_ADDR, PARTITION_UPDATE_ALL, PARTITION_USER1_FLAG_MASK,
  PARTITION_USER2_FLAG_MASK, PROGRAM_AGENT_ADDR,
  Package, PackageProperty, PartitionTableSize
} from './protocol';
import { subStep, mainStep } from './step';

const serial = navigator['serial']

@Injectable({
  providedIn: 'root'
})
export class OtaService {

  curMainOtaStep = mainStep.CUR_MAIN_STEP_IDEL;
  curSubOtaStep = subStep.CUR_SUB_STEP_RESET_CHIP;
  userCodeUpdateStart = false;
  asrUpdateStart = false;
  dnnUpdateStart = false;
  voiceUpdateStart = false;
  userFileUpdateStart = false;
  resetTryCount = 0;
  syncUpdaterTryCount = 0;
  // totalRcvUartArray.clear();
  needUpdatePartitionCount = 0;
  updateTimeCount = 0;
  //  updateTimingTimer->start(120000);   //2分钟
  updaterCrc16Val = 0; //代理程序CRC校验
  crc16Temp = 0;
  updateFlag = 0;            //update升级标志
  updateInfoCrc = 0;         //升级crc
  priorityCode = 0;          //优先升级的code（1或2）
  codeOffsetAddr = 0;
  codeSize = 0;

  partitionsInfoInDevice = null;
  updateInfo = null;

  port;
  writer;

  currentImageArray: Uint8Array;

  constructor() { }

  connectDevice() {
    return new Promise(async (resolve, reject) => {
      if ('serial' in navigator) {
        try {
          this.port = await serial.requestPort();
          resolve(true)
        } catch (err) {
          console.error('There was an error opening the serial port:', err);
          resolve(false)
        }
      } else {
        console.error('Web Serial API not supported.');
        resolve(false)
      }
    });
  }

  async openSerialport(baudRate = 115200) {
    console.log('Serial port:', this.port);
    await this.port.open({ baudRate: baudRate, bufferSize: 5120 });
    this.port.readable.pipeTo(new WritableStream({
      write: (data) => {
        console.log('Received data:', data);
      }
    }));
    this.writer = this.port.writable.getWriter();
  }

  closeSerialport() {
    if (this.port) {
      try {
        this.port.close();
      } catch (error) {

      }
    }
  }

  disconnectDevice() {
    if (this.port) {
      this.port.close();
      this.port = null;
    }
  }

  async send(data: Uint8Array | string) {
    if (typeof data === 'string') {
      // 把字符串每两个字符做分割，转成数组
      const hexArray = data.match(/[\s\S]{1,2}/g) || [];
      // 把HEX格式的字符串转成Uint8Array
      const numberArray = hexArray.map(hex => parseInt(hex, 16));
      data = new Uint8Array(numberArray);
    }
    console.log(data);
    await this.writer.write(data);
    // this.writer.releaseLock();
  }

  async runOTA() {
    // 选择串口
    await this.connectDevice();
    // 加载固件
    this.currentImageArray = await this.ReadImageFile()
    console.log(`固件总大小: ${this.currentImageArray.length} bytes`);

    // 发送复位指令
    await this.sendResetCmd();
    // 发送握手指令
    setTimeout(async () => {
      await this.sendDownLoadUpdaterCmd();
    }, 50);

    // this.StartOTAProcess();
  }

  sendResetCmdTimer;
  updateTimingTimer;
  sendBootloaderHandShakeCmdTimer;

  async StartOTAProcess() {
    const updateFirmeareSize = this.currentImageArray.length;

    this.ReadUpdaterFile()
    console.log(`updater文件总大小: ${this.curUpdaterArray.length} 字节`);

    this.curSubOtaStep = subStep.CUR_SUB_STEP_RESET_CHIP;

    this.sendResetCmd();
    this.sendResetCmdTimer = setTimeout(() => {
      this.sendResetCmd();
    }, 500);
    this.updateTimingTimer = setInterval(() => {
      this.updateTiming();
    }, 1000);
    this.sendBootloaderHandShakeCmdTimer = setInterval(() => {
      this.sendDownLoadUpdaterCmd();
    }, 20);
    this.curSubOtaStep = subStep.CUR_SBU_STEP_RESET_ANS;
    console.log(`复位后循环发送同Bootloader握手指令(20ms/一次): ${"OTA_REQUEST_CMD"}`);
  }

  //串口接收数据处理函数
  totalRcvUartArray = new Uint8Array();
  async OTAReadDataHandle(rcvData) {
    this.totalRcvUartArray = new Uint8Array([...this.totalRcvUartArray, ...rcvData]);
    let packageLen = 0;
    if (rcvData.length !== 0) {
      do {
        this.updateTimeCount = 0;
        packageLen = 0;
        let pPackage;
        console.log("rcvData = ", rcvData);
        if (this.totalRcvUartArray.length >= 10) {
          pPackage = this.ParseUartMsg(this.totalRcvUartArray, packageLen);
          console.log("packageLen = ", packageLen);
          console.log("curSubOtaStep = ", this.curSubOtaStep);
          if (pPackage === null) {
            console.log("解析芯片返回数据失败...");
            return;
          }
          console.log("pPackage.property.cmd = ", pPackage.property.cmd);
          if (this.curMainOtaStep == mainStep.CUR_MAIN_STEP_CHECK_UPDATER_PARTITION_INFO) {
            this.StepUpdatePartitionInfoCheck(pPackage, rcvData);
          }
        }
        this.totalRcvUartArray = this.totalRcvUartArray.slice(packageLen);
        console.log("移除解析过后的数据");
        console.log("totalRcvUartArray = ", this.totalRcvUartArray);
        rcvData = rcvData.slice(packageLen);

      } while (rcvData.length >= 10);
    } else {
      console.log("收到芯片错误数据:", rcvData);
    }
  }

  ParseUartMsg(rcvData: Uint8Array, dataLen: number): Package | null {
    let ret: Package = { property: { data_length: 0, crc: 0, tail: 0 } };
    ret.property.data_length = rcvData[2];
    if (ret.property.data_length > 1024) {
      return null;
    }
    ret.property.crc = GET_SWORD(rcvData.slice(7 + ret.property.data_length));
    ret.property.tail = rcvData[7 + ret.property.data_length + 2];
    console.log(`ret.property.data_length = ${ret.property.data_length}`);
    console.log(`ret.property.crc = ${ret.property.crc}`);
    console.log(`ret.property.tail = ${ret.property.tail}`);
    if (ret.property.tail === 0xFF) {
      let crc = CrcFunc(0, rcvData.slice(4), ret.property.data_length + 3);
      if (crc === ret.property.crc) {
        ret.property.msg_type = rcvData[4];
        ret.property.cmd = rcvData[5];
        ret.property.seq = rcvData[6];
        if (ret.property.data_length > 0) {
          ret.property.data = rcvData.slice(7, 7 + ret.property.data_length);
        }
        console.log("parse ok....");
        return ret;
      }
    }
    return null;
  }


  logOutText = 'TESTTT'
  StepUpdatePartitionInfoCheck(pPackage: any, rcvData: Uint8Array) {
    switch (this.curSubOtaStep) {
      case subStep.CUR_SBU_STEP_RESET_ANS:
      case subStep.CUR_SUB_STEP_RESET_SYNC_CHIP:
        if (pPackage.property.msg_type === 0xb0 && pPackage.property.cmd === 0x03) {
          // this.CloseSerialOTASlot();
          // this.serialPortBaudRateComboBox_ch1.setCurrentText("115200");
          // this.OpenSerialOTASlot();
          console.log("芯片收到复位指令，等待复位后握手", this.logOutText, 14, "white", "white");
          this.sendResetCmdTimer.stop();
          this.curSubOtaStep = subStep.CUR_SUB_STEP_RESET_SYNC_CHIP;
        }
        if (pPackage.property.msg_type === 0xa2 && pPackage.property.cmd === MSG_CMD_UPDATE_REQ) {
          console.log("收到Bootloader复位回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
          this.sendBootloaderHandShakeCmdTimer.stop();
          this.sendResetCmdTimer.stop();
          console.log("复位芯片后与Bootloader同步握手完成...", this.logOutText, 14, "white", "white");
          console.log("pPackage->property.cmd =", pPackage.property.cmd);
          this.sendUpdaterVerifyInfo(PROGRAM_AGENT_ADDR);
        }
        break;
      case subStep.CUR_SUB_STEP_SEND_UPDATER_VERIFY_INFO:
        console.log("收到Bootloader回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY_INFO) {
          console.log("发送updater代理程序校验到芯片应答成功", this.logOutText, 14, "green", "green");
          this.curSubOtaStep = subStep.CUR_SUB_STEP_SEND_UPDATER_DATA;
        }
        break;
      case subStep.CUR_SUB_STEP_SEND_UPDATER_DATA:
        console.log("收到Bootloader回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        console.log("pPackage->property.cmd =", pPackage.property.cmd);
        if (pPackage.property.cmd === MSG_CMD_UPDATE_WRITE) {
          let reqOffset = GET_LWORD(pPackage.property.data);
          let reqSize = GET_LWORD(pPackage.property.data + 4);
          reqSize = (reqSize > MAX_DATA_LENGTH) ? MAX_DATA_LENGTH : reqSize;
          console.log("芯片请求updater数据:请求大小=" + reqSize + "字节" + ", 请求偏移=" + reqOffset, this.logOutText, 14, "white", "white");
          this.ackWriteUpdaterToChip(reqOffset, reqSize);
        }
        if (pPackage.property.cmd === MSG_CMD_UPDATE_BLOCK_WRITE_DONE) {
          console.log("校验updater是否写入成功", this.logOutText, 14, "green", "green");
          this.cmdVerifyWriteUpdaterData();
          this.curSubOtaStep = subStep.CUR_SUB_STEP_VERIFY_UPDAGER;
        }
        break;
      case subStep.CUR_SUB_STEP_VERIFY_UPDAGER:
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY) {
          console.log("收到bootloader回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
          console.log("updater写入校验成功...", this.logOutText, 14, "green", "green");
        }
        if (pPackage.property.cmd === MSG_CMD_UPDATE_REQ) {
          console.log("收到updater回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
          console.log("检测updater是否运行成功", this.logOutText, 14, "green", "green");
          this.cmdHandShake();
          this.curSubOtaStep = subStep.CUR_SUB_STEP_CHECK_UPDATER_RUN_READY;
        }
        break;
      case subStep.CUR_SUB_STEP_CHECK_UPDATER_RUN_READY:
        console.log("收到updater回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        if (pPackage.property.cmd === MSG_CMD_UPDATE_CHECK_READY) {
          console.log("updater已运行成功...", this.logOutText, 14, "green", "green");
          console.log("切换updater运行波特率为:" + OTA_UPDATER_BAUDRATE + ",为下载固件做准备", this.logOutText, 14, "white", "white");
          this.curSubOtaStep = subStep.CUR_SUB_STEP_CHANGE_CHIP_BAUDRATE;
          this.cmdChangeUpdaterRunBaudrate(OTA_UPDATER_BAUDRATE);
        }
        break;
      case subStep.CUR_SUB_STEP_CHANGE_CHIP_BAUDRATE:
        console.log("收到updater回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        if (pPackage.property.cmd === MSG_CMD_CHANGE_BAUDRATE) {
          console.log("updater收到切换指令...", this.logOutText, 14, "white", "white");
          // this.CloseSerialOTASlot();
          // this.serialPortBaudRateComboBox_ch1.setCurrentText(this.updateBaudrateLineEdit.text());
          // this.OpenSerialOTASlot();
          this.curSubOtaStep = subStep.CUR_SUB_STEP_CHECK_CHANGE_BAUDRATE_OK;
          console.log("检测updater切换波特率是否成功", this.logOutText, 14, "green", "green");
          this.cmdHandShake();
        }
        break;
      case subStep.CUR_SUB_STEP_CHECK_CHANGE_BAUDRATE_OK:
        console.log("收到updater回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        if (pPackage.property.cmd === MSG_CMD_UPDATE_CHECK_READY) {
          console.log("updater运行波特率切换成功...", this.logOutText, 14, "green", "green");
        }
        console.log("设置固件版本为V1", this.logOutText, 14, "white", "white");
        this.curSubOtaStep = subStep.CUR_SUB_STEP_SET_FW_VER_V1;
        this.cmdSetFwVersion(FwFmtVer.FW_FMT_VER_1);
        break;
      case subStep.CUR_SUB_STEP_SET_FW_VER_V1:
        console.log("收到updater回复数据:" + toHexString(rcvData), this.logOutText, 14, "white", "white");
        if (pPackage.property.cmd === MSG_CMD_SET_FW_FMT_VER) {
          console.log("设置固件版本为V1成功...", this.logOutText, 14, "green", "green");
          console.log("获取芯片现有分区表信息", this.logOutText, 14, "white", "white");
          this.curSubOtaStep = subStep.CUR_SUB_STEP_GET_PAR_INFO;
          if (this.InitPartitionTableResource() !== 0) {
            console.log("分区表资源初始化失败", this.logOutText, 14, "red", "red");
            break;
          }
        }
        break;
      case subStep.CUR_SUB_STEP_GET_PAR_INFO:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_GET_INFO) {
          console.log("updater回复分区表数据格式为:包头(2byte)+数据长度(2byte)+消息类型(1byte)+指令(1byte)+seq(1byte)+updater版本号(4byte)+jedec_id(4byte)+分区表数据(nbyte)+UNIQUE_ID(16byte)+crc(2byte)+包尾(1byte)", this.logOutText, 14, 'white', 'white');
          console.log("获取芯片现有分区表信息成功...", this.logOutText, 14, 'green', 'green');
          this.partitionsInfoInDevice = pPackage.property.data.slice(8, 8 + PartitionTableSize);
          const updateFlag = this.checkNeedToUpdatePartition();
          console.log(`需要更新分区个数: ${this.needUpdatePartitionCount}个`, this.logOutText, 14, 'white', 'white');
          console.log(`updateFlag = ${updateFlag}`);
          if (updateFlag === PARTITION_INVALID_FILE_MASK) {
            console.log(`ERROR: Invalid upgrade file: ${updateFlag}`, this.logOutText, 14, 'white', 'white');
            break;
          } else if (updateFlag) {
            console.log("更新分区表1-发送分区表信息", this.logOutText, 14, 'white', 'white');
            this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE1_SEND_PARTITION_INFO;
            this.cmdSendPartitionInfo(PARTITION_TABLE1_START_ADDR, PartitionTableSize, 0);
          } else {
            console.log("----已经是最新固件无需升级----", this.logOutText, 14, 'red', 'red');

            clearInterval(this.updateTimingTimer)
            this.updateTimeCount = 0;
            this.cmdSendResetToUpdater();
            console.log("------芯片已复位-----", this.logOutText, 14, 'red', 'red');
            // this.serialPortBaudRateComboBox_ch1.setCurrentText(uartBaudRate.toString());
          }
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE1_SEND_PARTITION_INFO:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY_INFO) {
          console.log("更新分区表1-发送分区表信息成功...", this.logOutText, 14, 'green', 'green');
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE1_ERASE_PARTITION;
          console.log("更新分区表1-擦除分区表", this.logOutText, 14, 'white', 'white');
          this.cmdErasePartitionTable(PARTITION_TABLE1_START_ADDR, PartitionTableSize, ERASE_BLOCK_SIZE);
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE1_ERASE_PARTITION:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_ERA) {
          console.log("更新分区表1-擦除分区表成功...", this.logOutText, 14, 'green', 'green');
        }
        if (pPackage.property.cmd === MSG_CMD_UPDATE_WRITE) {
          console.log("更新分区表1-发送分区表数据", this.logOutText, 14, 'white', 'white');
          let reqSize = GET_LWORD(pPackage.property.data.slice(4));
          reqSize = (reqSize > MAX_DATA_LENGTH) ? MAX_DATA_LENGTH : reqSize;
          const reqOffset = GET_LWORD(pPackage.property.data);
          console.log(`req_offset = ${reqOffset}`);
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE1_WRITE_PARTITION_DATA;
          this.sendPartitionTable(this.updateInfo, PartitionTableSize, reqSize, reqOffset);
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE1_WRITE_PARTITION_DATA:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_BLOCK_WRITE_DONE) {
          console.log("更新分区表1-发送分区表数据成功...", this.logOutText, 14, 'green', 'green');
          console.log("更新分区表1-校验写入分区表数据", this.logOutText, 14, 'white', 'white');
          this.cmdVerifyPartitionInfo(PARTITION_TABLE1_START_ADDR, PartitionTableSize);
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE1_VERIRY_PARTITION;
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE1_VERIRY_PARTITION:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY) {
          if (pPackage.property.data[0] === 1) {
            console.log("更新分区表1-校验写入分区表数据成功...", this.logOutText, 14, 'green', 'green');
            this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE2_SEND_PARTITION_INFO;
            console.log("更新分区表2-发送分区表信息", this.logOutText, 14, 'white', 'white');
            this.cmdSendPartitionInfo(PARTITION_TABLE2_START_ADDR, PartitionTableSize, 0);
          } else {
            console.log("更新分区表1-校验写入分区表数据失败！！！", this.logOutText, 14, 'red', 'red');
          }
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE2_SEND_PARTITION_INFO:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY_INFO) {
          console.log("更新分区表2-发送分区表信息成功...", this.logOutText, 14, 'green', 'green');
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE2_ERASE_PARTITION;
          console.log("更新分区表2-擦除分区表", this.logOutText, 14, 'white', 'white');
          this.cmdErasePartitionTable(PARTITION_TABLE2_START_ADDR, PartitionTableSize, ERASE_BLOCK_SIZE);
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE2_ERASE_PARTITION:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_ERA) {
          console.log("更新分区表2-擦除分区表成功...", this.logOutText, 14, 'green', 'green');
        }
        if (pPackage.property.cmd === MSG_CMD_UPDATE_WRITE) {
          console.log("更新分区表2-发送分区表数据", this.logOutText, 14, 'white', 'white');
          let reqSize = GET_LWORD(pPackage.property.data.slice(4));
          reqSize = (reqSize > MAX_DATA_LENGTH) ? MAX_DATA_LENGTH : reqSize;
          const reqOffset = GET_LWORD(pPackage.property.data);
          console.log(`req_offset = ${reqOffset}`);
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE2_WRITE_PARTITION_DATA;
          this.sendPartitionTable(this.updateInfo, PartitionTableSize, reqSize, reqOffset);
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE2_WRITE_PARTITION_DATA:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_BLOCK_WRITE_DONE) {
          console.log("更新分区表2-发送分区表数据成功...", this.logOutText, 14, 'green', 'green');
          console.log("更新分区表2-校验写入分区表数据", this.logOutText, 14, 'white', 'white');
          this.cmdVerifyPartitionInfo(PARTITION_TABLE2_START_ADDR, PartitionTableSize);
          this.curSubOtaStep = subStep.CUR_SUB_STEP_UPDATE_TABLE2_VERIRY_PARTITION;
        }
        break;
      case subStep.CUR_SUB_STEP_UPDATE_TABLE2_VERIRY_PARTITION:
        console.log(`收到updater回复数据: ${toHexString(rcvData)}`, this.logOutText, 14, 'white', 'white');
        if (pPackage.property.cmd === MSG_CMD_UPDATE_VERIFY) {
          if (pPackage.property.data[0] === 1) {
            console.log("更新分区表2-校验写入分区表数据成功...", this.logOutText, 14, 'green', 'green');
            // 检查code分区是否需要升级
            console.log(`--updateFlag = ${this.updateFlag}`);
            if (this.updateFlag & PARTITION_USER1_FLAG_MASK) {
              this.priorityCode = 1;
              this.codeOffsetAddr = this.updateInfo.user_code1.address;
              this.codeSize = this.updateInfo.user_code1.size;
              this.updateInfoCrc = this.updateInfo.user_code1.crc;
              // console.log("======需要升级用户code 1======" , this.logOutText, 14, 'red', 'red');
            } else if (this.updateFlag & PARTITION_USER2_FLAG_MASK) {
              this.priorityCode = 2;
              this.codeOffsetAddr = this.updateInfo.user_code2.address;
              this.codeSize = this.updateInfo.user_code2.size;
              this.updateInfoCrc = this.updateInfo.user_code2.crc;
              // console.log("======需要升级用户code 2======" , this.logOutText, 14, 'red', 'red');
            }
            this.curMainOtaStep = mainStep.CUR_MAIN_STEP_IDEL;
          } else {
            console.log("更新分区表2-校验写入分区表数据失败 !!!", this.logOutText, 14, 'red', 'red');
          }
        }
        break;
      default:
        break;
    }
  }

  //发送复位业务固件指令
  async sendResetCmd() {
    // this.closeSerialport();
    await this.openSerialport();
    await this.send(OTA_RESET_CMD)

    // if (resetTryCount++ > 200) {   //尝试200次
    //   syncUpdaterTryCount = 0;
    //   promptMessage.PromptMessageSet("升级状态", "升级失败，请检查芯片型号和参数配置后重试!", 3);
    //   this.sendResetCmdTimer.stop();
    //   this.sendBootloaderHandShakeCmdTimer.stop();
    // }
  }

  // 发送下载更新器指令
  async sendDownLoadUpdaterCmd() {
    this.send(OTA_REQUEST_CMD)
    // const OTA_REQUEST_CMD = "your command here";
    // await this.sendRequestToServer('write', this.hexStringToByteArray(OTA_REQUEST_CMD));
    // if (this.syncUpdaterTryCount++ > 200) {   //尝试200次
    //   this.resetTryCount = 0;
    //   console.log("升级状态", "升级超时，请重试...");
    //   clearInterval(this.sendBootloaderHandShakeCmdTimer);
    //   clearInterval(this.sendResetCmdTimer);
    // }
  }


  //升级计超时计算
  async updateTiming() {
    //10S无响应超时
    if (this.updateTimeCount++ > 10) {
      this.updateTimeCount = 0;
      console.log("升级状态", "升级失败，请检查芯片型号和参数配置后重试!");
      clearInterval(this.updateTimingTimer)
      clearTimeout(this.sendResetCmdTimer)
      clearInterval(this.sendBootloaderHandShakeCmdTimer)
      // await this.serialService.disconnect();
    }
  }


  // 读取updater
  curUpdaterArray: Uint8Array;
  async ReadUpdaterFile(url = '/assets/ota/ci130x_updater.bin') {
    const response = await fetch(url);
    // 检查响应是否ok
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    // 使用Response.arrayBuffer方法将其转换为ArrayBuffer
    const buffer = await response.arrayBuffer();
    // 将ArrayBuffer转换为Uint8Array
    this.curUpdaterArray = new Uint8Array(buffer);
  }

  // 读取固件
  async ReadImageFile(url = '/assets/ota/Simplified_115200_V0.0.1.bin') {
    const response = await fetch(url);
    // 检查响应是否ok
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    // 使用Response.arrayBuffer方法将其转换为ArrayBuffer
    const buffer = await response.arrayBuffer();
    // 将ArrayBuffer转换为Uint8Array
    return new Uint8Array(buffer);
  }

  //读取分区表信息
  CmdReadPartitionTable(): number {
    let package1 = new PackageT({
      data_length: 0,
      cmd: MSG_CMD_GET_INFO,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: null,
    })
    // this.newPackage(MSG_CMD_GET_INFO, MSG_TYPE_CMD, 1, null, 0);
    this.sendPackage(package1);
    // this.DelPackage(package);
    return 0;
  }

  calcPartitionListChecksum(file_config): number {
    let len = Object.keys(file_config).length - 2;
    let sum = 0;
    let UserCode1Status = file_config.user_code1.status;
    let UserCode2Status = file_config.user_code2.status;
    let ASRCMDModelStatus = file_config.asr_cmd_model.status;
    let DNNModelStatus = file_config.dnn_model.status;
    let VoicePlayingStatus = file_config.voice.status;
    let UserFileStatus = file_config.user_file.status;

    file_config.user_code1.status = 0xF0;
    file_config.user_code2.status = (file_config.FirmwareFormatVer == 1) ? 0xF0 : 0xFF;
    file_config.asr_cmd_model.status = 0;
    file_config.dnn_model.status = 0;
    file_config.voice.status = 0;
    file_config.user_file.status = 0;

    for (let key in file_config) {
      if (file_config.hasOwnProperty(key)) {
        sum += file_config[key];
      }
    }

    file_config.user_code1.status = UserCode1Status;
    file_config.user_code2.status = UserCode2Status;
    file_config.asr_cmd_model.status = ASRCMDModelStatus;
    file_config.dnn_model.status = DNNModelStatus;
    file_config.voice.status = VoicePlayingStatus;
    file_config.user_file.status = UserFileStatus;
    return sum;
  }


  partitionsInfoInFile = null;
  checkNeedToUpdatePartition(): number {
    let ret = 0;
    if (this.partitionsInfoInFile.PartitionTableChecksum !== this.calcPartitionListChecksum(this.partitionsInfoInFile)) {
      return PARTITION_INVALID_FILE_MASK;
    }

    if (this.partitionsInfoInDevice.PartitionTableChecksum !== this.calcPartitionListChecksum(this.partitionsInfoInDevice)) {
      this.updateInfo = { ...this.partitionsInfoInFile };
      this.updateInfo.user_code1.status = 0xFC;
      this.updateInfo.user_code2.status = 0xFC;
      this.updateInfo.asr_cmd_model.status = 0xFF;
      this.updateInfo.dnn_model.status = 0xFF;
      this.updateInfo.voice.status = 0xFF;
      this.updateInfo.user_file.status = 0xFF;
      this.updateInfo.PartitionTableChecksum = this.calcPartitionListChecksum(this.updateInfo);
      console.log("INFO: device partition be destroyed! update all", this.logOutText, 14, "red", "red");
      this.needUpdatePartitionCount = 5;
      return PARTITION_UPDATE_ALL;
    }

    this.updateInfo = { ...this.partitionsInfoInDevice };
    Object.assign(this.updateInfo, this.partitionsInfoInFile); // Assuming this is the correct conversion for memcpy

    console.log("updateInfo->SWName = ", this.updateInfo.SWName);
    console.log("updateInfo->SWVersion = ", this.updateInfo.SWVersion);

    return ret;
    // ... rest of the code follows the same pattern of conversion
    // replace qDebug() with console.log()
    // replace this-> with this.
    // replace memcpy with Object.assign()
    // replace pointers with direct object references
  }

  sendPartitionTable(pSrcData: Uint8Array, size: number, reqSize: number, reqOffset: number) {
    let pDstData = new Uint8Array(4096 + 4);
    pDstData.fill(0);
    let rst = 0;
    if (!pSrcData) {
      return 2;
    }
    new DataView(pDstData.buffer).setUint32(0, reqOffset, true);
    if (pSrcData) {
      if (reqOffset >= size)
        rst = 0;
      else if (reqOffset + reqSize > size)
        rst = size - reqOffset;
      else
        rst = reqSize;
      pDstData.set(pSrcData.subarray(reqOffset, reqOffset + rst), 4);
    }
    if (rst < reqSize) {
      pDstData.fill(0xFF, 4 + rst, reqSize - rst);
    }
    this.crc16Temp = 0;
    this.crc16Temp = CrcFunc(this.crc16Temp, pDstData.subarray(4, 4 + reqSize));
    let data1 = new Uint8Array(reqSize);
    for (let i = 0; i < reqSize; i++) {
      data1[i] = pDstData[4 + i];
    }
    let package1 = new PackageT({
      data_length: reqSize + 4,
      cmd: MSG_CMD_UPDATE_WRITE,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: data1,
    })
    // this.newPackage(MSG_CMD_UPDATE_WRITE, MSG_TYPE_ACK, 0, pDstData, reqSize + 4);
    this.sendPackage(package1);
    // this.DelPackage(package);
    return 0;
  }

  //分区表资源初始化
  InitPartitionTableResource(): number {
    // 在TypeScript中，我们不需要手动分配内存，只需要创建新的对象实例
    this.partitionsInfoInDevice = new Uint8Array(4096);
    if (!this.partitionsInfoInDevice) {
      console.log("CmdReadPartitionTable---1");
      return -1;
    }

    this.updateInfo = new Uint8Array(4096);
    if (!this.updateInfo) {
      console.log("CmdReadPartitionTable---3");
      return -1;
    }

    if (this.CmdReadPartitionTable() != 0) { //获取当前固件分区表
      return -1;
    }

    return 0;
  }

  cmdErasePartitionTable(addr_in_flash: number, size: number, erase_block_size: number) {
    let data = new ArrayBuffer(12);
    let view = new DataView(data);

    view.setUint32(0, addr_in_flash, true);
    view.setUint32(4, size, true);
    view.setUint32(8, erase_block_size, true);

    let package1 = new PackageT({
      data_length: 12,
      cmd: MSG_CMD_UPDATE_ERA,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: new Uint8Array(data),
    })
    // this.newPackage(MSG_CMD_UPDATE_ERA, MSG_TYPE_CMD, 0, data, 12);
    this.sendPackage(package1);
    // this.DelPackage(package);
  }

  cmdSendResetToUpdater(): number {
    let package1 = new PackageT({
      data_length: 0,
      cmd: MSG_CMD_SYS_RST,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: null,
    })
    // this.newPackage(MSG_CMD_SYS_RST, MSG_TYPE_CMD, 0, null, 0);
    this.sendPackage(package1);
    return 0;
  }

  sendUpdaterVerifyInfo(agent_runaddr: number) {
    let transport_agent_count = 0;
    let data = new Uint8Array(10);
    let updater_size = this.curUpdaterArray.length;
    let erase_size = (updater_size + MIN_PARTITION_SIZE - 1) / MIN_PARTITION_SIZE * MIN_PARTITION_SIZE;
    /*计算crc16*/
    this.updaterCrc16Val = CrcFunc(0, new Uint8Array(this.curUpdaterArray.buffer), this.curUpdaterArray.length);
    for (transport_agent_count = 0; transport_agent_count < erase_size - updater_size; transport_agent_count++) {
      const fill_byte = 0xFF;
      this.updaterCrc16Val = CrcFunc(this.updaterCrc16Val, new Uint8Array([fill_byte]), 1);
    }
    console.log("updaterCrc16Val = ", this.updaterCrc16Val);
    console.log("curUpdaterArray.length = ", this.curUpdaterArray.length);

    // console.log("发送updater代理程序校验到芯片:运行地址+文件大小+CRC16校验值", this.logOutText, 14, "white", "white");
    new DataView(data.buffer).setUint32(0, agent_runaddr, true);
    new DataView(data.buffer).setUint32(4, erase_size, true);
    new DataView(data.buffer).setUint16(8, this.updaterCrc16Val, true);
    //发送升级代理信息（起始地址，大小,CRC）
    this.curSubOtaStep = subStep.CUR_SUB_STEP_SEND_UPDATER_VERIFY_INFO;
    let package1 = new PackageT({
      data_length: 10,
      cmd: MSG_CMD_UPDATE_VERIFY_INFO,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: data,
    })
    // this.newPackage(MSG_CMD_UPDATE_VERIFY_INFO, MSG_TYPE_CMD, 1, data, 10);
    this.sendPackage(package1);
    // this.delPackage(package1);
  }

  cmdVerifyPartitionInfo(addr_in_flash: number, size: number) {
    let buffer = new ArrayBuffer(10);
    let view = new DataView(buffer);

    view.setUint32(0, addr_in_flash, true);
    view.setInt32(4, size, true);
    view.setUint16(8, this.crc16Temp, true);

    console.log("send crc16Temp = ", this.crc16Temp);

    let package1 = new PackageT({
      data_length: 10,
      cmd: MSG_CMD_UPDATE_VERIFY_INFO,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: new Uint8Array(buffer),
    })
    // this.newPackage(MSG_CMD_UPDATE_VERIFY, MSG_TYPE_CMD, 1, new Uint8Array(buffer), 10);
    this.sendPackage(package1);
    // this.DelPackage(package);
  }

  cmdVerifyWriteUpdaterData() {
    let package1 = new PackageT({
      data_length: 0,
      cmd: MSG_CMD_UPDATE_VERIFY,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: null,
    })
    // this.newPackage(MSG_CMD_UPDATE_VERIFY, MSG_TYPE_CMD, 1, null, 0);
    this.sendPackage(package1);
    // this.DelPackage(package);
  }

  cmdHandShake() {
    let package1 = new PackageT({
      data_length: 0,
      cmd: MSG_CMD_UPDATE_REQ,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: null,
    })
    // this.newPackage(MSG_CMD_UPDATE_CHECK_READY, MSG_TYPE_CMD, 1, null, 0);
    this.sendPackage(package1);
  }

  //切换串口波特率
  cmdChangeUpdaterRunBaudrate(baudrate) {
    let package1 = new PackageT({
      data_length: 1,
      cmd: MSG_CMD_CHANGE_BAUDRATE,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: new Uint8Array([baudrate]),
    })
    // this.newPackage(MSG_CMD_CHANGE_BAUDRATE, MSG_TYPE_CMD, 1, baudrate, 4);
    this.sendPackage(package1);
  }

  cmdSetFwVersion(ver) {
    let package1 = new PackageT({
      data_length: 1,
      cmd: MSG_CMD_SET_FW_FMT_VER,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: ver,
    })
    // this.newPackage(MSG_CMD_SET_FW_FMT_VER, MSG_TYPE_CMD, 1, ver, 1);
    this.sendPackage(package1);
    // DelPackage(package);
  }

  cmdSendPartitionInfo(addr_in_flash: number, size: number, crc: number): void {
    let data = new ArrayBuffer(10);
    let view = new DataView(data);

    view.setUint32(0, addr_in_flash, true);
    view.setUint32(4, size, true);
    view.setUint16(8, crc, true);

    let package1 = new PackageT({
      data_length: 10,
      cmd: MSG_CMD_UPDATE_VERIFY_INFO,
      msg_type: MSG_TYPE_CMD,
      seq: 1,
      data: new Uint8Array(data),
    })
    this.sendPackage(package1);
  }

  ackWriteUpdaterToChip(reqOffset: number, reqSize: number): void {
    let pData = new Uint8Array(4096 + 4);
    if (reqOffset === 0) {
      this.crc16Temp = 0;
    }
    console.log("curUpdaterArray size = ", this.curUpdaterArray.length);
    let rst = 0;
    if (reqOffset >= this.curUpdaterArray.length)
      rst = 0;
    else if (reqOffset + reqSize > this.curUpdaterArray.length)
      rst = this.curUpdaterArray.length - reqOffset;
    else
      rst = reqSize;
    console.log("rst = ", rst);
    let pUpdater = this.curUpdaterArray;
    let reqOffsetBytes = new Uint8Array(new Uint32Array([reqOffset]).buffer);
    pData.set(reqOffsetBytes);
    pData.set(pUpdater.subarray(reqOffset, reqOffset + rst), 4);

    if (rst < reqSize) {
      pData.fill(0xFF, 4 + rst, reqSize - rst);
    }
    this.crc16Temp = CrcFunc(this.crc16Temp, pData.subarray(4, 4 + reqSize));
    let package1 = new PackageT({
      data_length: reqSize + 4,
      cmd: MSG_CMD_UPDATE_WRITE,
      msg_type: MSG_TYPE_ACK,
      seq: 0,
      data: pData,
    });
    this.sendPackage(package1);
  }

  sendPackage(packageT: PackageT) {
    if (packageT.rawData.data1.length > 0) this.send(packageT.rawData.data1);  //发送包头+数据长度+消息类型+指令
    if (packageT.rawData.data2.length > 0) this.send(packageT.rawData.data2);  //发送数据
    if (packageT.rawData.data3.length > 0) this.send(packageT.rawData.data3);  //发送CRC加包尾
  }

  newPackage(cmd: number, msg_type: number, seq: number, data: Uint8Array, data_length: number): PackageProperty {
    let packageProperty: PackageProperty = {
      head: 0x0FA5,
      data_length: data_length,
      msg_type: msg_type,
      cmd: cmd,
      seq: seq,
      data: data,
      crc: CrcFunc(0, new Uint8Array([msg_type]), 3),
      tail: 0xff
    };


    packageProperty.crc = CrcFunc(packageProperty.crc, packageProperty.data, packageProperty.data_length);

    return packageProperty;
  }

}

class PackageT {
  property: PackageProperty;

  data1: Uint8Array;
  data2: Uint8Array;
  data3: Uint8Array;

  get rawData() {
    return { data1: this.data1, data2: this.data2, data3: this.data3 };
  }

  constructor(property: PackageProperty) {
    this.property = property;
    this.data1 = new Uint8Array(7); //包头+数据长度+消息类型+指令
    this.data2 = new Uint8Array(this.property.data_length); //数据
    this.data3 = new Uint8Array(3); //CRC+包尾

    let view = new DataView(this.data1.buffer);
    view.setUint16(0, 0x0FA5, true);
    view.setUint16(2, this.property.data_length, true);
    view.setUint8(4, this.property.msg_type);
    view.setUint8(5, this.property.cmd);
    view.setUint8(6, this.property.seq);

    this.data2.set(this.property.data);

    view = new DataView(this.data3.buffer);
    view.setUint16(0, this.property.crc, true);
    view.setUint8(2, 0xFF);
  }

}

function toHexString(byteArray: Uint8Array): string {
  return byteArray.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
}

function GET_LWORD(p: Uint8Array): number {
  return (p[0]) + (p[1] << 8) + (p[2] << 16) + (p[3] << 24);
}

function GET_SWORD(p: Uint8Array): number {
  return (p[0]) + (p[1] << 8);
}

function CrcFunc(crc: number, buf: Uint8Array, len?: number): number {
  for (let counter = 0; counter < buf.length; counter++) {
    const t = buf[counter];
    crc = (crc << 8) ^ crc16tab_ccitt[((crc >> 8) ^ t) & 0x00FF];
  }
  return crc;
}

const crc16tab_ccitt: number[] = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
  0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
  0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
  0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
  0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
  0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
  0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
  0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
  0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
  0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
  0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
  0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
  0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
  0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
  0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
  0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
  0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
  0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
  0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
  0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
  0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
  0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
  0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
  0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
  0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
  0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
  0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
  0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
  0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
  0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
  0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0
]