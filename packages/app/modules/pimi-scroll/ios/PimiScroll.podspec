Pod::Spec.new do |s|
  s.name           = 'PimiScroll'
  s.version        = '0.1.0'
  s.summary        = 'Scroll view corrections for Pimi'
  s.description    = 'Scroll view corrections for Pimi'
  s.license        = 'PolyForm-Noncommercial-1.0.0'
  s.author         = 'Pimi'
  s.homepage       = 'https://1ikeadragon.github.io/pimi/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.source_files = "**/*.{h,mm}"

  install_modules_dependencies(s)
end
