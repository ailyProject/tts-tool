import { ChangeDetectorRef, Component } from '@angular/core';
import { MarkdownComponent } from '../../component/markdown/markdown.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSliderModule } from 'ng-zorro-antd/slider';
import { OtaService } from './ota.service';
import { blockList } from './block/block.config';
import { DragulaModule, DragulaService } from 'ng2-dragula';
import { BlockComponent } from './block/block.component';
import { Subscription } from 'rxjs';
import { AsrService } from './asr.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

@Component({
  selector: 'app-asr',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzStepsModule,
    NzInputNumberModule,
    NzInputModule,
    NzButtonModule,
    NzSelectModule,
    NzSliderModule,
    DragulaModule,
    BlockComponent,
    NzToolTipModule
  ],
  templateUrl: './asr.component.html',
  styleUrl: './asr.component.scss'
})
export class AsrComponent {

  blockList = blockList
  subs = new Subscription();

  get weekCmdList() {
    return this.asrService.weekCmdList
  }

  set weekCmdList(value) {
    this.asrService.weekCmdList = value
  }

  get asrCmdList() {
    return this.asrService.asrCmdList
  }

  set asrCmdList(value) {
    this.asrService.asrCmdList = value
  }

  get intCmdList() {
    return this.asrService.intCmdList
  }

  set intCmdList(value) {
    this.asrService.intCmdList = value
  }

  get serialCmdList() {
    return this.asrService.serialCmdList
  }

  set serialCmdList(value) {
    this.asrService.serialCmdList = value
  }

  get speech() {
    return this.asrService.speech
  }

  set speech(value) {
    this.asrService.speech = value
  }

  get serial() {
    return this.asrService.serial
  }

  set serial(value) {
    this.asrService.serial = value
  }

  constructor(
    private otaService: OtaService,
    private dragulaService: DragulaService,
    private asrService: AsrService,
    private cd: ChangeDetectorRef
  ) {
    this.dragulaService.createGroup('VAMPIRES', {
      copy: (el, source) => {
        return source.id === 'block-bar';
      },
      copyItem: (block: any) => {
        return block;
      },
      accepts: (el, target, source, sibling) => {
        return target.id !== 'block-bar';
      },
      direction: 'horizontal'
    });

    this.subs.add(this.dragulaService.dropModel('VAMPIRES')
      .subscribe(({ el, target, source, sourceModel, targetModel, item }) => {
        setTimeout(() => {
          this.asrService.save()
        }, 1000)
      })
    );

    this.subs.add(this.dragulaService.removeModel('VAMPIRES')
      .subscribe(({ el, source, item, sourceModel }) => {
        // console.log('removeModel', el, source)
      })
    );

    this.asrService.load()

  }


  // // 将数据暂存储到localStorage
  // save() {
  //   const data = {
  //     weekCmdList: this.weekCmdList,
  //     asrCmdList: this.asrCmdList,
  //     intCmdList: this.intCmdList,
  //     serialCmdList: this.serialCmdList
  //   }
  //   localStorage.setItem('asr', JSON.stringify(data))
  // }

  // // 从localStorage中获取数据
  // load() {
  //   const data = JSON.parse(localStorage.getItem('asr'))
  //   if (data) {
  //     this.weekCmdList = data.weekCmdList
  //     this.asrCmdList = data.asrCmdList
  //     this.intCmdList = data.intCmdList
  //     this.serialCmdList = data.serialCmdList
  //   }
  // }

  ngOnDestroy(): void {
    this.dragulaService.destroy('VAMPIRES')
  }

  runOTA() {
    console.log('runOTA')
    this.otaService.runOTA()
  }


  addAsrCmd() {
    this.asrCmdList.push([])
  }


  addIntCmd() {
    this.intCmdList.push([])
  }

  addSerialCmd() {
    this.serialCmdList.push([])
  }

  settingchange() {

  }

  test() {
    console.log(this.speech);
    console.log(this.serial);
    console.log(this.weekCmdList);
    console.log(this.asrCmdList);
    console.log(this.intCmdList);
    console.log(this.serialCmdList);
  }

  exportFile() {
    let config = {
      speech: this.speech,
      serial: this.serial,
      weekCmdList: this.weekCmdList,
      asrCmdList: this.asrCmdList,
      intCmdList: this.intCmdList,
      serialCmdList: this.serialCmdList
    }
    download(config)
  }

  importFile() {
    let fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.onchange = (e) => {
      let file = fileInput.files[0];
      let reader = new FileReader();
      reader.onload = (e) => {
        let result = JSON.parse(reader.result as string);
        this.speech = result.speech;
        this.serial = result.serial;
        this.weekCmdList = result.weekCmdList;
        this.asrCmdList = result.asrCmdList;
        this.intCmdList = result.intCmdList;
        this.serialCmdList = result.serialCmdList;
        this.cd.detectChanges();
      }
      reader.readAsText(file);
    }
    fileInput.click();
  }

  clearAll() {
    this.weekCmdList = [[]]
    this.asrCmdList = [[]]
    this.intCmdList = [[]]
    this.serialCmdList = [[]]
  }

}

function download(config) {
  // 将对象转换为 JSON 格式的字符串
  let dataStr = JSON.stringify(config);

  // 创建一个 Blob 对象，内容为上面的字符串
  let dataBlob = new Blob([dataStr], { type: 'text/plain' });

  // 创建一个指向 Blob 对象的 URL
  let url = URL.createObjectURL(dataBlob);

  // 创建一个隐藏的 <a> 元素，设置其 href 为上面的 URL
  let downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = 'config.json';

  // 将 <a> 元素添加到文档中
  document.body.appendChild(downloadLink);

  // 触发点击事件，开始下载
  downloadLink.click();

  // 下载完成后，删除 <a> 元素
  document.body.removeChild(downloadLink);
}
