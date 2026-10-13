export class ChartEngine {
  constructor(canvas, bars) {
    this.canvas = canvas;
    this.bars = bars;
    canvas.addEventListener("pointerdown", (event) => this.pick(event));
  }

  pick(event) {
    this.selected = Math.floor(event.offsetX / 8);
    this.draw();
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.bars.forEach((bar, i) => {
      const top = 130 - bar.close;
      ctx.fillRect(i * 8, top, 6, Math.max(1, bar.high - bar.low));
    });
  }
}

const response = await fetch("/data.json");
const bars = await response.json();
new ChartEngine(document.getElementById("probe-chart"), bars).draw();
