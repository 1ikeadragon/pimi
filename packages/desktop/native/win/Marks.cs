using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;

namespace PimiDesktopHelper
{
    static class Marks
    {
        static readonly Color[] Palette = {
            Color.FromArgb(230, 25, 75), Color.FromArgb(60, 180, 75), Color.FromArgb(0, 130, 200), Color.FromArgb(245, 130, 48),
            Color.FromArgb(145, 30, 180), Color.FromArgb(0, 150, 150), Color.FromArgb(200, 30, 200), Color.FromArgb(128, 100, 0) };

        static Color ColorFor(int ct)
        {
            switch (ct) { case 50000: case 50031: return Palette[0]; case 50004: case 50003: case 50030: return Palette[1]; case 50002: case 50013: return Palette[2];
                case 50011: case 50010: return Palette[3]; case 50007: case 50024: case 50029: return Palette[4]; case 50019: return Palette[5]; case 50005: return Palette[6]; }
            return Palette[7];
        }

        // Draws onto a native-resolution canvas. `scale` is the planned final scale so tags stay legible.
        public static string Draw(Bitmap canvas, RECT canvasScreen, List<Node> nodes, double scale)
        {
            var legend = new StringBuilder();
            float fontPx = (float)Math.Max(11, Math.Min(40, 13 / Math.Max(scale, 0.05)));
            using (var g = Graphics.FromImage(canvas))
            using (var font = new Font("Arial", fontPx, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                int penW = Math.Max(2, (int)Math.Round(2 / Math.Max(scale, 0.05)));
                var used = new List<Rectangle>();
                foreach (var n in nodes)
                {
                    if (n.Ref <= 0 || !n.Interactive) continue;
                    int x = n.R.Left - canvasScreen.Left, y = n.R.Top - canvasScreen.Top;
                    var box = new Rectangle(x, y, n.R.W, n.R.H);
                    if (box.Right < 0 || box.Bottom < 0 || box.Left > canvas.Width || box.Top > canvas.Height) continue;
                    var col = ColorFor(n.Ct);
                    using (var pen = new Pen(col, penW)) g.DrawRectangle(pen, box.X, box.Y, Math.Max(1, box.Width - 1), Math.Max(1, box.Height - 1));
                    string txt = n.Ref.ToString();
                    var sz = g.MeasureString(txt, font);
                    int tw = (int)sz.Width + 2, th = (int)sz.Height;
                    int tx = Math.Max(0, Math.Min(canvas.Width - tw, box.X)), ty = Math.Max(0, box.Y);
                    var tag = new Rectangle(tx, ty, tw, th);
                    for (int tries = 0; tries < 6; tries++)
                    {
                        bool hit = false;
                        foreach (var u in used) if (u.IntersectsWith(tag)) { hit = true; tag.Y = u.Bottom; break; }
                        if (!hit) break;
                    }
                    if (tag.Bottom > canvas.Height) tag.Y = Math.Max(0, canvas.Height - th);
                    used.Add(tag);
                    using (var br = new SolidBrush(col)) g.FillRectangle(br, tag);
                    g.DrawString(txt, font, Brushes.White, tag.X + 1, tag.Y);
                    legend.Append(n.Ref).Append(' ').Append(U.Role(n.Ct));
                    if (n.Name.Length > 0) legend.Append(" \"").Append(n.Name.Length > 60 ? n.Name.Substring(0, 60) : n.Name.Replace("\"", "'")).Append('"');
                    legend.Append('\n');
                }
            }
            return legend.ToString().TrimEnd('\n');
        }

        public static void Grid(Bitmap img)
        {
            using (var g = Graphics.FromImage(img))
            using (var pen = new Pen(Color.FromArgb(150, 255, 0, 255), 1))
            using (var font = new Font("Arial", 11, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                for (int x = 100; x < img.Width; x += 100)
                {
                    g.DrawLine(pen, x, 0, x, img.Height);
                    g.DrawString(x.ToString(), font, Brushes.Magenta, x + 2, 2);
                }
                for (int y = 100; y < img.Height; y += 100)
                {
                    g.DrawLine(pen, 0, y, img.Width, y);
                    g.DrawString(y.ToString(), font, Brushes.Magenta, 2, y + 2);
                }
            }
        }
    }
}
